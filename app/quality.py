"""Administrator preferences and evidence, separate from measured route facts."""

import copy
import math
from datetime import UTC, datetime

import sqlalchemy as sa

from app.database.models import Node, NodeAnnotation, QualityPolicy, QualityPolicyRevision
from app.domain import PROTOCOLS, AssetError

PREFERENCES = (
    "preferred_entry_countries",
    "preferred_exit_countries",
    "preferred_entry_asns",
    "preferred_exit_asns",
    "preferred_protocols",
)
DEFAULT_POLICY = {
    "min_samples": 3,
    "poor_success_rate": 0.8,
    "evidence_max_age_days": 90,
    **{key: [] for key in PREFERENCES},
    "operator_preferences": {},
}
OPERATORS = ("GENERAL", "CT", "CU", "CM")


def _label(value, limit=40):
    return (
        isinstance(value, str)
        and 0 < len(value) <= limit
        and "://" not in value
        and not any(ord(c) < 32 or ord(c) == 127 for c in value)
    )


def validate_policy(value):
    if not isinstance(value, dict) or set(value) - DEFAULT_POLICY.keys():
        raise AssetError("INVALID_QUALITY_POLICY")
    result = {**copy.deepcopy(DEFAULT_POLICY), **copy.deepcopy(value)}
    for key, low, high in (("min_samples", 1, 7), ("evidence_max_age_days", 1, 365)):
        if type(result[key]) is not int or not low <= result[key] <= high:
            raise AssetError("INVALID_QUALITY_POLICY")
    rate = result["poor_success_rate"]
    if type(rate) not in (int, float) or not math.isfinite(rate) or not 0 <= rate <= 1:
        raise AssetError("INVALID_QUALITY_POLICY")
    operators = result["operator_preferences"]
    if not isinstance(operators, dict) or set(operators) - set(OPERATORS):
        raise AssetError("INVALID_QUALITY_POLICY")
    for prefs in [result, *operators.values()]:
        if not isinstance(prefs, dict) or prefs is not result and set(prefs) - set(PREFERENCES):
            raise AssetError("INVALID_QUALITY_POLICY")
        for key in PREFERENCES:
            values = prefs.get(key, [])
            if not isinstance(values, list) or len(values) > 100:
                raise AssetError("INVALID_QUALITY_POLICY")
            for item in values:
                if key.endswith("countries"):
                    valid = (
                        isinstance(item, str)
                        and len(item) == 2
                        and item.isascii()
                        and item.isupper()
                        and item.isalpha()
                    )
                elif key.endswith("asns"):
                    valid = type(item) is int and 0 <= item <= 4294967295
                else:
                    valid = item in PROTOCOLS
                if not valid:
                    raise AssetError("INVALID_QUALITY_POLICY")
            if key in prefs:
                prefs[key] = sorted(set(values))
    return result


def validate_annotation(value):
    allowed = {"tags", "line_claim", "evidence_level", "manual_priority", "operators", "reference"}
    if not isinstance(value, dict) or set(value) - allowed:
        raise AssetError("INVALID_NODE_ANNOTATION")
    result = copy.deepcopy(value)
    for key, choices in (
        ("line_claim", ("UNKNOWN", "IPLC", "IEPL", "CN2", "OTHER")),
        ("evidence_level", ("NONE", "DECLARED", "DOCUMENTED")),
        ("manual_priority", ("NONE", "P1", "P2", "P3")),
    ):
        if key in result and result[key] not in choices:
            raise AssetError("INVALID_NODE_ANNOTATION")
    for key in ("tags", "operators"):
        if key in result:
            items = result[key]
            if not isinstance(items, list) or len(items) > 16 or any(not _label(i) for i in items):
                raise AssetError("INVALID_NODE_ANNOTATION")
            if key == "operators" and (not items or set(items) - set(OPERATORS)):
                raise AssetError("INVALID_NODE_ANNOTATION")
            result[key] = sorted(set(items))
    if (
        "reference" in result
        and result["reference"] is not None
        and not _label(result["reference"], 2000)
    ):
        # References can contain URLs and are only returned by the explicit evidence endpoint.
        ref = result["reference"]
        if (
            not isinstance(ref, str)
            or not 1 <= len(ref) <= 2000
            or any(ord(c) < 32 or ord(c) == 127 for c in ref)
        ):
            raise AssetError("INVALID_NODE_ANNOTATION")
    return result


class QualityService:
    def __init__(self, assets):
        self.assets, self.sessions = assets, assets.sessions

    def policy(self):
        with self.sessions() as session:
            row = session.get(QualityPolicy, 1)
            return {
                "version": row.version,
                "policy": row.policy,
                "updated_at": row.updated_at,
                "history": [
                    {"version": r.version, "policy": r.policy, "created_at": r.created_at}
                    for r in session.scalars(
                        sa.select(QualityPolicyRevision)
                        .order_by(QualityPolicyRevision.version.desc())
                        .limit(50)
                    )
                ],
            }

    def set_policy(self, policy, expected_version=None):
        policy = validate_policy(policy)
        with self.sessions.begin() as session:
            row = session.scalar(
                sa.select(QualityPolicy).where(QualityPolicy.id == 1).with_for_update()
            )
            if expected_version is not None and (
                type(expected_version) is not int or row.version != expected_version
            ):
                raise AssetError("QUALITY_POLICY_CONFLICT")
            row.policy, row.version, row.updated_at = policy, row.version + 1, datetime.now(UTC)
            session.add(QualityPolicyRevision(version=row.version, policy=policy))
        return self.policy()

    def annotation(self, node_id):
        with self.sessions() as session:
            if session.get(Node, node_id) is None:
                raise AssetError("NODE_NOT_FOUND")
            row = session.get(NodeAnnotation, node_id)
            if row is None:
                return {
                    "tags": [],
                    "line_claim": "UNKNOWN",
                    "evidence_level": "NONE",
                    "manual_priority": "NONE",
                    "operators": ["GENERAL"],
                    "has_evidence": False,
                    "evidence_updated_at": None,
                    "updated_at": None,
                }
            return {
                **{
                    k: getattr(row, k)
                    for k in (
                        "tags",
                        "line_claim",
                        "evidence_level",
                        "manual_priority",
                        "operators",
                        "evidence_updated_at",
                        "updated_at",
                    )
                },
                "has_evidence": row.reference_data is not None,
            }

    def annotate(self, node_id, payload):
        data = validate_annotation(payload)
        with self.sessions.begin() as session:
            if session.get(Node, node_id) is None:
                raise AssetError("NODE_NOT_FOUND")
            # Lock the asset row too: concurrent first annotations cannot overwrite silently.
            session.execute(sa.select(Node.id).where(Node.id == node_id).with_for_update())
            row = session.get(NodeAnnotation, node_id)
            if row is None:
                row = NodeAnnotation(node_id=node_id)
                session.add(row)
                session.flush()
            if "reference" in data:
                reference = data.pop("reference")
                row.reference_data = bytes(reference.encode()) if reference else None
                row.evidence_updated_at = datetime.now(UTC) if reference else None
            for key, value in data.items():
                setattr(row, key, value)
            if row.evidence_level == "DOCUMENTED" and not row.reference_data:
                raise AssetError("EVIDENCE_REFERENCE_REQUIRED")
            row.updated_at = datetime.now(UTC)
        return self.annotation(node_id)

    def reveal_reference(self, node_id):
        with self.sessions() as session:
            if session.get(Node, node_id) is None:
                raise AssetError("NODE_NOT_FOUND")
            row = session.get(NodeAnnotation, node_id)
            if row is None or row.reference_data is None:
                return {"reference": None}
            return {"reference": bytes(row.reference_data).decode()}

    def refresh_metrics(self, node_ids=None):
        with self.sessions.begin() as session:
            session.execute(
                sa.text("SELECT nodema_refresh_runner_summaries(CAST(:ids AS uuid[]))"),
                {"ids": node_ids},
            )
