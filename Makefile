UUID := notchboard@kanterlabs.dev

.PHONY: install status restore test test-shell

## Install, or update a running copy in place (first install needs one logout)
install:
	./scripts/install.sh

## Print the running release
status:
	python3 scripts/reload.py --status

## Emergency recovery: disable and restore every setting Notchboard changed
restore:
	python3 scripts/restore.py

## Pure-JS grid tests and schema check
test:
	node --test tests/grid.test.mjs
	glib-compile-schemas --strict --dry-run $(UUID)/schemas

## Real headless GNOME Shell integration suite
test-shell:
	./tests/shell.sh
