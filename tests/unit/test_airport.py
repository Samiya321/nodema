from datetime import UTC, datetime

from app.ingestion.airport import is_info_node, parse_airport_headers


def test_userinfo_with_floats_milliseconds_and_title_fallbacks():
    info = parse_airport_headers(
        {
            "Subscription-Userinfo": (
                "upload=1.5E3; download=2048; total=1073741824; expire=1893456000000"
            ),
            "Content-Disposition": "attachment; filename*=UTF-8''%E6%9C%BA%E5%9C%BA%20A",
        }
    )
    assert (info.upload, info.download, info.total) == (1500, 2048, 1073741824)
    assert info.expires_at == datetime(2030, 1, 1, tzinfo=UTC)
    assert info.title == "机场 A" and info.match_key == "title:机场 a"


def test_no_usage_header_is_not_an_airport_and_bad_values_are_ignored():
    assert parse_airport_headers({"profile-title": "x"}) is None
    info = parse_airport_headers(
        {
            "subscription-userinfo": "upload=-5; download=; total=10; expire=0",
            "profile-title": "base64:!!!",
            "profile-web-page-url": "javascript:alert(1)",
        }
    )
    assert info.upload == 0 and info.download is None and info.total == 10
    assert info.expires_at is None and info.title is None and info.website is None


def test_website_keeps_only_origin():
    info = parse_airport_headers(
        {
            "subscription-userinfo": "total=1",
            "profile-web-page-url": "https://panel.example:8443/user?token=abc",
        }
    )
    assert info.website == "https://panel.example:8443" and info.match_key == ("site:panel.example")


def test_info_nodes_are_detected_but_real_nodes_are_not():
    assert is_info_node("剩余流量：12.5 GB") and is_info_node("套餐到期：2030-01-01")
    assert is_info_node("官网 example.com") and is_info_node("Traffic: 10GB")
    assert not is_info_node("香港 01 IPLC") and not is_info_node("🇸🇬 Singapore 02")
