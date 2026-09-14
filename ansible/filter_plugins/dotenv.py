"""Use the backend dotenv serializer for operator-managed Ansible values."""
import importlib.util
from pathlib import Path

path = Path(__file__).resolve().parents[2] / "pi-dns-warden/monitoring/backup-manager/env_store.py"
spec = importlib.util.spec_from_file_location("torhole_env_store", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FilterModule:
    def filters(self):
        return {"torhole_dotenv": module.serialize_env_value}
