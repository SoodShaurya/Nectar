const serverAddressInput = document.getElementById('server-address');
const serverPortInput = document.getElementById('server-port');
const usernameInput = document.getElementById('username');
const versionInput = document.getElementById('version');
const createBotBtn = document.getElementById('create-bot-btn');
const botListDiv = document.getElementById('bot-list');

let socket;
let availableActivities = []; // Store available activities from backend

function connectWebSocket() {
    // Determine WebSocket protocol (ws or wss)
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}`; // Connect to the same host serving the HTML

    console.log(`Connecting WebSocket to ${wsUrl}`);
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
        console.log('WebSocket connection established.');
        botListDiv.innerHTML = '<p>Connected. Fetching bot list...</p>';
        // Request initial data (server.js already sends this on connection, but good practice)
        // sendMessage('getBotList');
        // sendMessage('getActivities');
    };

    socket.onmessage = (event) => {
        console.log('Message from server:', event.data);
        try {
            const message = JSON.parse(event.data);
            handleServerMessage(message);
        } catch (error) {
            console.error('Failed to parse server message:', error);
            botListDiv.innerHTML = '<p>Error processing server message.</p>';
        }
    };

    socket.onclose = (event) => {
        console.log('WebSocket connection closed:', event.reason || 'No reason specified');
        botListDiv.innerHTML = `<p>Disconnected from server. Attempting to reconnect in 5 seconds...</p>`;
        // Attempt to reconnect after a delay
        setTimeout(connectWebSocket, 5000);
    };

    socket.onerror = (error) => {
        console.error('WebSocket error:', error);
        botListDiv.innerHTML = '<p>WebSocket connection error. Check server status.</p>';
        // Don't automatically reconnect on error immediately, wait for onclose
    };
}

function sendMessage(type, payload = {}) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        const message = JSON.stringify({ type, payload });
        console.log('Sending message:', message);
        socket.send(message);
    } else {
        console.error('WebSocket is not connected.');
        // Optionally display an error to the user
    }
}

function handleServerMessage(message) {
    const { type, payload } = message;
    switch (type) {
        case 'botListUpdate':
            renderBotList(payload);
            break;
        case 'availableActivities':
            availableActivities = payload;
            // Re-render list to update dropdowns if they exist
            // This assumes renderBotList uses the global availableActivities
            const currentBots = getCurrentBotDataFromDOM(); // Need a way to get current bot data if list isn't sent again
            renderBotList(currentBots); // Re-render with new activities
            break;
        case 'error':
            alert(`Server Error: ${payload}`); // Simple error display
            break;
        default:
            console.log('Unknown message type received:', type);
    }
}

// Helper to get current bot data if needed for re-rendering
function getCurrentBotDataFromDOM() {
    const botElements = botListDiv.querySelectorAll('.bot-item');
    const bots = [];
    botElements.forEach(el => {
        const botId = el.dataset.botId;
        const statusEl = el.querySelector('.bot-status');
        const activityEl = el.querySelector('.bot-activity');
        // This is simplified; ideally, you'd store the full bot object somewhere
        if (botId && statusEl && activityEl) {
             bots.push({
                 id: botId,
                 status: statusEl.textContent.split(': ')[1],
                 activity: activityEl.textContent.split(': ')[1]
                 // options would need to be stored/retrieved too if needed
             });
        }
    });
    return bots;
}


function renderBotList(bots) {
    if (!bots || bots.length === 0) {
        botListDiv.innerHTML = '<p>No active bots.</p>';
        return;
    }

    botListDiv.innerHTML = ''; // Clear previous list

    bots.forEach(bot => {
        const botDiv = document.createElement('div');
        botDiv.classList.add('bot-item');
        botDiv.dataset.botId = bot.id; // Store bot ID for later use

        // Display Info
        const infoDiv = document.createElement('div');
        infoDiv.innerHTML = `
            <strong>${bot.id}</strong><br>
            <span class="bot-status">Status: ${bot.status}</span><br>
            <span class="bot-activity">Activity: ${bot.activity || 'N/A'}</span>
        `;
        botDiv.appendChild(infoDiv);

        // Controls Div
        const controlsDiv = document.createElement('div');
        controlsDiv.classList.add('bot-controls');

        // Activity Selector
        const activitySelect = document.createElement('select');
        activitySelect.classList.add('activity-select');
        availableActivities.forEach(actName => {
            const option = document.createElement('option');
            option.value = actName;
            option.textContent = actName;
            if (actName === bot.activity) {
                option.selected = true;
            }
            activitySelect.appendChild(option);
        });
        controlsDiv.appendChild(activitySelect);

        // Change Activity Button
        const changeActivityBtn = document.createElement('button');
        changeActivityBtn.textContent = 'Change Activity';
        changeActivityBtn.onclick = () => {
            const selectedActivity = activitySelect.value;
            sendMessage('changeActivity', { botId: bot.id, activityName: selectedActivity });
        };
        // Disable controls if bot is not in a state to change activity
        if (bot.status !== 'idle') {
             changeActivityBtn.disabled = true;
             activitySelect.disabled = true;
        }
        controlsDiv.appendChild(changeActivityBtn);


        // Delete Button
        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = 'Delete';
        deleteBtn.classList.add('delete-btn');
        deleteBtn.onclick = () => {
            if (confirm(`Are you sure you want to delete bot ${bot.id}?`)) {
                sendMessage('deleteBot', { botId: bot.id });
            }
        };
        controlsDiv.appendChild(deleteBtn);

        botDiv.appendChild(controlsDiv);
        botListDiv.appendChild(botDiv);
    });
}

// --- Event Listeners ---
createBotBtn.addEventListener('click', () => {
    const host = serverAddressInput.value.trim();
    const port = serverPortInput.value.trim();
    const username = usernameInput.value.trim();
    const version = versionInput.value.trim(); // Optional

    if (!host || !port || !username) {
        alert('Please fill in Server Address, Port, and Bot Username.');
        return;
    }

    sendMessage('createBot', {
        host,
        port: parseInt(port, 10),
        username,
        version: version || undefined // Send undefined if empty
    });

    // Clear username for next bot, keep server details
    usernameInput.value = '';
});

// --- Initial Connection ---
connectWebSocket();
