#!/bin/bash

# Aetherius Development Stop Script
# Gracefully stops all running services

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_header() {
    echo -e "${BLUE}╔════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║       AETHERIUS - Development Stop Script         ║${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════════════════╝${NC}"
    echo ""
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

print_header

# Check for tmux session
if tmux has-session -t aetherius 2>/dev/null; then
    print_info "Stopping tmux session 'aetherius'..."
    tmux kill-session -t aetherius
    print_success "Tmux session stopped"
fi

# Check for screen sessions
if screen -ls | grep -q "aetherius-"; then
    print_info "Stopping screen sessions..."
    screen -ls | grep "aetherius-" | cut -d. -f1 | awk '{print $1}' | xargs -I {} screen -S {} -X quit
    print_success "Screen sessions stopped"
fi

# Kill any remaining node processes related to aetherius
if pgrep -f "@aetherius" > /dev/null; then
    print_info "Stopping remaining aetherius processes..."
    pkill -f "@aetherius"
    sleep 2
    print_success "All processes stopped"
fi

echo ""
print_success "AETHERIUS services have been stopped"
echo ""
