BIN_DIR := $(HOME)/.bun/bin
BINARY  := mc

.PHONY: build install uninstall

build:
	bun build --compile --outfile $(BINARY) mc.ts

install: build
	cp $(BINARY) $(BIN_DIR)/$(BINARY)
	@echo "Installed to $(BIN_DIR)/$(BINARY)"

uninstall:
	rm -f $(BIN_DIR)/$(BINARY)
	@echo "Removed $(BIN_DIR)/$(BINARY)"
