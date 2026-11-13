"""Grading rules (single row + revisions), shared by Actions and the local API."""

from datetime import UTC, datetime

import sqlalchemy as sa

from app.database.models import GradingPolicy, GradingPolicyRevision
from app.domain import AssetError
from app.grading import DEFAULT_GRADING, validate_grading


def load_policy(session) -> dict:
    row = session.get(GradingPolicy, 1)
    try:
        return validate_grading(row.policy if row else {})
    except AssetError:
        return validate_grading({})


class GradingPolicyService:
    def __init__(self, sessions):
        self.sessions = sessions

    def get(self) -> dict:
        with self.sessions() as session:
            row = session.get(GradingPolicy, 1)
            return {
                "version": row.version,
                "policy": load_policy(session),
                "defaults": DEFAULT_GRADING,
                "updated_at": row.updated_at,
                "history": [
                    {"version": r.version, "created_at": r.created_at}
                    for r in session.scalars(
                        sa.select(GradingPolicyRevision)
                        .order_by(GradingPolicyRevision.version.desc())
                        .limit(20)
                    )
                ],
            }

    def set(self, policy, expected_version=None) -> dict:
        policy = validate_grading(policy)
        with self.sessions.begin() as session:
            row = session.scalar(
                sa.select(GradingPolicy).where(GradingPolicy.id == 1).with_for_update()
            )
            if expected_version is not None and (
                type(expected_version) is not int or row.version != expected_version
            ):
                raise AssetError("GRADING_POLICY_CONFLICT")
            row.policy, row.version, row.updated_at = policy, row.version + 1, datetime.now(UTC)
            session.add(GradingPolicyRevision(version=row.version, policy=policy))
        return self.get()
