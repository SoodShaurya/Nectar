#!/bin/bash

# Aetherius Development Startup Script
# Starts all services in the correct order with proper error handling

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Functions
print_header() {
    echo -e "${BLUE}╔════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║      AETHERIUS - Development Startup Script       ║${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════════════════╝${NC}"
    echo ""
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

check_requirements() {
    print_info "Checking requirements..."

    # Check Node.js
    if ! command -v node &> /dev/null; then
        print_error "Node.js is not installed. Please install Node.js 20.x or later."
        exit 1
    fi
    print_success "Node.js $(node --version) found"

    # Check pnpm
    if ! command -v pnpm &> /dev/null; then
        print_error "pnpm is not installed. Run: npm install -g pnpm"
        exit 1
    fi
    print_success "pnpm $(pnpm --version) found"

    # Check MongoDB
    if ! pgrep -x mongod > /dev/null; then
        print_warning "MongoDB is not running. Please start MongoDB before continuing."
        read -p "Press Enter when MongoDB is running, or Ctrl+C to exit..."
    fi
    print_success "MongoDB is running"

    # Check .env file
    if [ ! -f ".env" ]; then
        print_warning ".env file not found"
        read -p "Do you want to create it from .env.example? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            cp .env.example .env
            print_success "Created .env from .env.example"
            print_warning "Please edit .env with your actual values before continuing"
            exit 0
        else
            print_error "Cannot continue without .env file"
            exit 1
        fi
    fi
    print_success ".env file found"

    # Check GEMINI_API_KEY
    source .env
    if [ -z "$GEMINI_API_KEY" ] || [ "$GEMINI_API_KEY" = "your_gemini_api_key_here" ]; then
        print_error "GEMINI_API_KEY not set in .env"
        exit 1
    fi
    print_success "GEMINI_API_KEY is configured"

    echo ""
}

build_project() {
    print_info "Building project..."
    if pnpm run build > /dev/null 2>&1; then
        print_success "Build completed successfully"
    else
        print_error "Build failed. Check logs above."
        exit 1
    fi
    echo ""
}

start_service() {
    local service=$1
    local name=$2
    local terminal=$3

    print_info "Starting $name..."

    case $terminal in
        "tmux")
            tmux new-window -n "$name" "pnpm --filter @aetherius/$service start"
            ;;
        "screen")
            screen -dmS "aetherius-$service" bash -c "pnpm --filter @aetherius/$service start"
            ;;
        *)
            print_error "Unknown terminal multiplexer: $terminal"
            exit 1
            ;;
    esac

    sleep 2
    print_success "$name started"
}

# Main execution
print_header

# Check if running in a terminal multiplexer
if command -v tmux &> /dev/null; then
    TERMINAL="tmux"
    print_info "Using tmux for service management"
elif command -v screen &> /dev/null; then
    TERMINAL="screen"
    print_info "Using GNU screen for service management"
else
    print_warning "No terminal multiplexer found (tmux or screen)"
    print_info "Services will be started in background"
    TERMINAL="background"
fi

check_requirements
build_project

print_info "Starting services in order..."
echo ""

# Start services
if [ "$TERMINAL" = "tmux" ]; then
    # Create new tmux session
    tmux new-session -d -s aetherius -n "world-state"
    tmux send-keys "pnpm --filter @aetherius/world-state-service start" C-m
    print_success "World State Service started in tmux window 'world-state'"
    sleep 3

    tmux new-window -n "bsm"
    tmux send-keys "pnpm --filter @aetherius/bot-server-manager start" C-m
    print_success "Bot Server Manager started in tmux window 'bsm'"
    sleep 2

    tmux new-window -n "orchestrator"
    tmux send-keys "pnpm --filter @aetherius/orchestrator-service start" C-m
    print_success "Orchestrator started in tmux window 'orchestrator'"
    sleep 2

    echo ""
    print_success "All services started successfully!"
    echo ""
    print_info "To attach to the tmux session, run: tmux attach -t aetherius"
    print_info "To switch between windows, use: Ctrl+B then number (0, 1, 2, ...)"
    print_info "To detach from tmux, use: Ctrl+B then D"
    print_info "To kill all services, run: tmux kill-session -t aetherius"

elif [ "$TERMINAL" = "screen" ]; then
    screen -dmS aetherius-world-state bash -c "pnpm --filter @aetherius/world-state-service start"
    print_success "World State Service started in screen session 'aetherius-world-state'"
    sleep 3

    screen -dmS aetherius-bsm bash -c "pnpm --filter @aetherius/bot-server-manager start"
    print_success "Bot Server Manager started in screen session 'aetherius-bsm'"
    sleep 2

    screen -dmS aetherius-orchestrator bash -c "pnpm --filter @aetherius/orchestrator-service start"
    print_success "Orchestrator started in screen session 'aetherius-orchestrator'"
    sleep 2

    echo ""
    print_success "All services started successfully!"
    echo ""
    print_info "To list screen sessions, run: screen -ls"
    print_info "To attach to a session, run: screen -r aetherius-<service>"
    print_info "To detach from screen, use: Ctrl+A then D"

else
    pnpm --filter @aetherius/world-state-service start > logs/world-state.log 2>&1 &
    print_success "World State Service started (PID: $!)"
    sleep 3

    pnpm --filter @aetherius/bot-server-manager start > logs/bsm.log 2>&1 &
    print_success "Bot Server Manager started (PID: $!)"
    sleep 2

    pnpm --filter @aetherius/orchestrator-service start > logs/orchestrator.log 2>&1 &
    print_success "Orchestrator started (PID: $!)"
    sleep 2

    echo ""
    print_success "All services started in background!"
    print_info "Check logs in: logs/"
    print_info "To stop all services, run: pkill -f aetherius"
fi

echo ""
print_header
print_success "AETHERIUS is now running!"
echo ""
print_info "Monitor your services and check logs for any issues."
print_info "The system is ready to receive goals and coordinate agents."
echo ""
