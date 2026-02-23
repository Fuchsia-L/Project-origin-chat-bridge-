import pytest

from app.services.layered_memory_service import (
    _extract_json_array,
    _validate_scope_fields,
)


def test_extract_json_array_from_fenced_json():
    raw = """```json
[
  {"content":"用户喜欢晨跑","scope":"user_global","category":"preference","importance":4}
]
```"""
    parsed = _extract_json_array(raw)
    assert isinstance(parsed, list)
    assert parsed[0]["scope"] == "user_global"


def test_validate_scope_fields_require_character_id():
    with pytest.raises(ValueError):
        _validate_scope_fields("character", None, None)
    character_id, project_id = _validate_scope_fields("character", "persona-1", None)
    assert character_id == "persona-1"
    assert project_id is None


def test_validate_scope_fields_require_project_id():
    with pytest.raises(ValueError):
        _validate_scope_fields("project", None, None)
    character_id, project_id = _validate_scope_fields("project", None, "proj-1")
    assert character_id is None
    assert project_id == "proj-1"
