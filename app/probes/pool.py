"""Round-robin credentials with per-account, concurrency-safe free-test budgets.

Each configured token should represent a separate authorized account: Globalping
applies quotas to users, not tokens. Never fall back to anonymous requests. Unknown
budgets are excluded rather than guessing and potentially spending credits.
"""

from dataclasses import dataclass
from threading import Lock

from app.probes.globalping import ApiError, Client, RateLimited, integer


@dataclass
class Account:
    client: Client
    remaining: int = 0
    enabled: bool = False


class ClientPool:
    authenticated = True

    def __init__(self, clients: list[Client], reserve: int = 5, max_tests: int = 5000):
        if not clients or any(not client.authenticated for client in clients):
            raise ValueError("Authenticated clients required")
        self.accounts = [Account(client) for client in clients]
        self.reserve = reserve
        self.max_tests = max_tests
        self.spent = 0
        self.lock = Lock()
        self.cursor = 0
        self.owners: dict[str, Client] = {}
        self.rate_limited = 0

    @property
    def remaining(self) -> int:
        with self.lock:
            return sum(account.remaining for account in self.accounts if account.enabled)

    @property
    def available(self) -> int:
        with self.lock:
            return min(
                self.max_tests - self.spent,
                sum(
                    max(0, account.remaining - self.reserve)
                    for account in self.accounts
                    if account.enabled
                ),
            )

    def limits(self) -> int:
        errors = []
        for account in self.accounts:
            try:
                remaining = account.client.limits()
                if remaining is None:
                    raise ApiError("INVALID_RESPONSE")
                account.remaining = remaining
                account.enabled = True
            except RateLimited:
                account.enabled = False
                self.rate_limited += 1
            except ApiError as error:
                account.enabled = False
                errors.append(error.code)
        if not any(account.enabled for account in self.accounts):
            if errors:
                raise ApiError(errors[0])
            raise RateLimited()
        return self.remaining

    def probes(self):
        for account in self.accounts:
            if not account.enabled:
                continue
            try:
                return account.client.probes()
            except (ApiError, RateLimited):
                continue
        raise ApiError("PROBES_UNAVAILABLE")

    def create(self, body: dict) -> str:
        # Planner requests use locations[].limit (one test per selected probe).
        cost = integer(body.get("limit")) or sum(
            integer(location.get("limit")) or 1 for location in body.get("locations", [])
        )
        cost = max(1, cost)
        while True:
            with self.lock:
                if self.spent + cost > self.max_tests:
                    raise RateLimited()
                account = None
                for offset in range(len(self.accounts)):
                    index = (self.cursor + offset) % len(self.accounts)
                    candidate = self.accounts[index]
                    if candidate.enabled and candidate.remaining - self.reserve >= cost:
                        account = candidate
                        self.cursor = (index + 1) % len(self.accounts)
                        # Reserve before releasing the lock: queued workers cannot
                        # spend the same tests. Uncertain failures are not refunded.
                        account.remaining -= cost
                        self.spent += cost
                        break
                if account is None:
                    raise RateLimited()
            try:
                identifier = account.client.create(body)
            except RateLimited:
                with self.lock:
                    account.enabled = False
                    self.rate_limited += 1
                continue
            except ApiError as error:
                if error.code not in ("HTTP_401", "HTTP_403"):
                    raise
                with self.lock:
                    account.enabled = False
                continue
            with self.lock:
                if account.client.remaining is not None:
                    account.remaining = min(account.remaining, account.client.remaining)
                self.owners[identifier] = account.client
            return identifier

    def wait(self, identifier: str) -> list:
        with self.lock:
            client = self.owners.pop(identifier)
        return client.wait(identifier)
