import pytest

from app.domain import AssetError
from app.quality import validate_annotation, validate_policy


@pytest.mark.parametrize(
    "value",
    [
        None,
        [],
        {"secret": "private"},
        {"min_samples": True},
        {"min_samples": 8},
        {"poor_success_rate": float("nan")},
        {"preferred_entry_asns": [True]},
        {"preferred_entry_countries": ["hk"]},
        {"preferred_protocols": ["other"]},
        {"preferred_protocols": None},
        {"operator_preferences": {"CT": {"secret": "private"}}},
    ],
)
def test_policy_validation_is_strict_and_redacted(value):
    with pytest.raises(AssetError, match="^INVALID_QUALITY_POLICY$"):
        validate_policy(value)


@pytest.mark.parametrize(
    "value",
    [
        {"tags": ["https://private.example/secret"]},
        {"line_claim": ["IPLC"]},
        {"evidence_level": "VERIFIED"},
        {"operators": []},
        {"reference": "private\r\nsecret"},
        {"reference": 123},
        {"reference": "private\x7f"},
        {"mainland_reachability": "UP"},
    ],
)
def test_annotation_cannot_set_measured_facts_or_leak_input(value):
    with pytest.raises(AssetError, match="^INVALID_NODE_ANNOTATION$"):
        validate_annotation(value)


def test_preferences_normalize_without_inventing_network_rankings():
    policy = validate_policy(
        {
            "preferred_entry_countries": ["JP", "HK", "JP"],
            "operator_preferences": {"CT": {"preferred_entry_asns": [64520, 64510]}},
        }
    )
    assert policy["preferred_entry_countries"] == ["HK", "JP"]
    assert policy["operator_preferences"]["CT"]["preferred_entry_asns"] == [64510, 64520]
    assert policy["preferred_exit_asns"] == []
