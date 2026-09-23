import os
import yaml

def test_seed_yaml_exists_and_valid():
    seed_path = "seed.yaml"
    assert os.path.exists(seed_path), "seed.yaml does not exist"

    with open(seed_path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)

    assert isinstance(data, dict), "seed.yaml must parse as a dictionary"

    required_fields = ["organ", "tier", "status", "produces", "consumes"]
    for field in required_fields:
        assert field in data, f"Missing required field: {field}"

    assert data["organ"] == "ops"
    assert isinstance(data["tier"], int)
    assert data["status"] == "parked"
    assert isinstance(data["produces"], list)
    assert isinstance(data["consumes"], list)
