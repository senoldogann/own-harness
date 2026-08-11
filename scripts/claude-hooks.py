import sys

script_dir = __file__.rsplit("/", 1)[0]
sys.path.insert(0, script_dir)

from claude_hook_asset import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
