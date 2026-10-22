// Global state
let currentUser = null;
let authToken = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    // Load user from localStorage
    const userStr = localStorage.getItem('user');
    const token = localStorage.getItem('token');

    if (userStr && token) {
        currentUser = JSON.parse(userStr);
        authToken = token;
    }

    initializeChatbot();
});

// API Helper
async function apiCall(endpoint, options = {}) {
    const defaultOptions = {
        headers: {
            'Content-Type': 'application/json',
            ...(authToken && { 'Authorization': `Bearer ${authToken}` })
        }
    };

    const response = await fetch(endpoint, { ...defaultOptions, ...options });
    return response.json();
}

// Chatbot Functionality
function initializeChatbot() {
    const trigger = document.getElementById('chatbot-trigger');
    const window = document.getElementById('chatbot-window');
    const close = document.getElementById('chatbot-close');
    const input = document.getElementById('chatbot-input-field');
    const send = document.getElementById('chatbot-send');
    const messages = document.getElementById('chatbot-messages');

    if (!trigger || !window) return;

    trigger.addEventListener('click', () => {
        window.classList.remove('hidden');
        trigger.style.display = 'none';
    });

    close.addEventListener('click', () => {
        window.classList.add('hidden');
        trigger.style.display = 'flex';
    });

    // Handle suggestion buttons
    document.addEventListener('click', (e) => {
        if (e.target.classList.contains('suggestion-btn')) {
            const question = e.target.dataset.question;
            addMessage(question, 'user');
            const answer = getChatbotAnswer(question);
            setTimeout(() => addMessage(answer, 'bot'), 500);
        }
    });

    // Handle send button
    if (send) {
        send.addEventListener('click', () => {
            const message = input.value.trim();
            if (message) {
                addMessage(message, 'user');
                input.value = '';
                const answer = getChatbotAnswer(message);
                setTimeout(() => addMessage(answer, 'bot'), 500);
            }
        });
    }

    // Handle enter key
    if (input) {
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                send.click();
            }
        });
    }
}

function addMessage(text, sender) {
    const messages = document.getElementById('chatbot-messages');
    if (!messages) return;

    const messageDiv = document.createElement('div');
    messageDiv.className = `chatbot-message ${sender}`;
    messageDiv.innerHTML = `<p>${text}</p>`;
    messages.appendChild(messageDiv);
    messages.scrollTop = messages.scrollHeight;
}

function getChatbotAnswer(question) {
    const lowerQuestion = question.toLowerCase();

    if (lowerQuestion.includes('submit') || lowerQuestion.includes('report')) {
        return 'To submit a complaint: 1) Login/Register, 2) Go to your dashboard, 3) Click "Report Problem", 4) Fill in machine details, location, problem description, 5) Upload photos (optional), 6) Submit. You\'ll receive a unique ticket ID for tracking.';
    }

    if (lowerQuestion.includes('track') || lowerQuestion.includes('status')) {
        return 'You can track your complaint by logging into your dashboard. Go to "My Complaints" section where you\'ll see all your submitted complaints with their current status. Click on any complaint to see detailed information, status timeline, and updates.';
    }

    if (lowerQuestion.includes('information') || lowerQuestion.includes('need')) {
        return 'When submitting a complaint, please provide: 1) Machine name/ID, 2) Laboratory/Room number, 3) Problem category (malfunction, calibration, etc.), 4) Detailed description of the issue, 5) When the problem occurred, 6) Photos of the problem (if possible). The more details you provide, the faster we can resolve the issue.';
    }

    if (lowerQuestion.includes('in progress')) {
        return '"In Progress" status means a technician has started working on your complaint. The machine is currently being inspected, repaired, or serviced. You\'ll receive updates as the work continues and will be notified once the issue is resolved.';
    }

    if (lowerQuestion.includes('assigned')) {
        return '"Assigned" status means your complaint has been verified by the HOD/Faculty and assigned to a technician or staff member for resolution. Work will begin shortly.';
    }

    if (lowerQuestion.includes('resolved')) {
        return '"Resolved" means the technician has completed the repair/maintenance work. The complaint is awaiting final verification by the HOD/Faculty before being closed.';
    }

    if (lowerQuestion.includes('urgent') || lowerQuestion.includes('emergency')) {
        return 'For urgent safety issues or emergencies, please: 1) Stop using the machine immediately, 2) Submit a complaint marking it as "Critical" priority, 3) Contact the department office directly at the helpline number. Safety issues are given highest priority.';
    }

    if (lowerQuestion.includes('photo') || lowerQuestion.includes('image')) {
        return 'To upload photos: When filling the complaint form, click the "Upload Image" button, select up to 5 photos (JPEG, JPG, PNG, WebP formats), and preview them before submitting. Photos help technicians understand the problem better. Maximum file size: 5MB per image.';
    }

    if (lowerQuestion.includes('ticket') || lowerQuestion.includes('id')) {
        return 'Your ticket ID (e.g., PPD-2026-000123) is displayed immediately after submitting a complaint. You can find it in your dashboard under "My Complaints". Use this ID to track your complaint status or when communicating with department staff.';
    }

    if (lowerQuestion.includes('how long') || lowerQuestion.includes('time')) {
        return 'Resolution time depends on the problem severity and complexity. Critical issues are addressed within 24 hours. Regular maintenance typically takes 2-5 days. You can check estimated completion time in your complaint details if a due date has been set.';
    }

    return 'I can help you with:\n• How to submit a complaint\n• Tracking your complaint status\n• Understanding status meanings\n• What information to include\n• Upload photos\n• Finding your ticket ID\n\nPlease ask your specific question or click one of the suggestions above.';
}

// Utility Functions
function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-IN', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// Escape user supplied values before inserting them into the DOM
function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getStatusBadgeClass(status) {
    return `status-badge status-${status.toLowerCase().replace(' ', '-')}`;
}

function getPriorityBadgeClass(priority) {
    return `priority-badge priority-${priority.toLowerCase()}`;
}

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.remove();
    }, 3000);
}

// Notification bell shared by every authenticated dashboard
function initNotificationBell(containerId = 'notification-bell') {
    const container = document.getElementById(containerId);
    const token = localStorage.getItem('token');
    if (!container || !token) return;

    container.classList.add('notification-bell');
    container.innerHTML = `
        <button class="notif-btn" id="notif-btn" title="Notifications" aria-label="Notifications">
            <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22zm7-6v-5a7 7 0 0 0-5.5-6.83V3a1.5 1.5 0 0 0-3 0v1.17A7 7 0 0 0 5 11v5l-1.3 1.3a1 1 0 0 0 .7 1.7h15.2a1 1 0 0 0 .7-1.7L19 16z"/>
            </svg>
            <span class="notif-badge hidden" id="notif-badge">0</span>
        </button>
        <div class="notif-panel hidden" id="notif-panel">
            <div class="notif-panel-header">
                <strong>Notifications</strong>
                <button class="notif-read-all" id="notif-read-all">Mark all as read</button>
            </div>
            <div class="notif-list" id="notif-list">
                <div class="notif-empty">Loading notifications…</div>
            </div>
        </div>
    `;

    const panel = document.getElementById('notif-panel');
    const badge = document.getElementById('notif-badge');
    const list = document.getElementById('notif-list');

    async function loadNotifications() {
        try {
            const response = await fetch('/api/dashboard/notifications', {
                headers: { Authorization: `Bearer ${token}` }
            });
            const data = await response.json();
            if (!data.success) return;

            if (data.unread_count > 0) {
                badge.textContent = data.unread_count > 9 ? '9+' : data.unread_count;
                badge.classList.remove('hidden');
            } else {
                badge.classList.add('hidden');
            }

            if (data.notifications.length === 0) {
                list.innerHTML = '<div class="notif-empty">No notifications yet.</div>';
                return;
            }

            list.innerHTML = data.notifications.map((n) => `
                <div class="notif-item ${n.read_status ? '' : 'unread'}" data-id="${n.id}">
                    <span class="notif-title">${escapeHtml(n.title)}</span>
                    <span>${escapeHtml(n.message)}</span>
                    <div class="notif-time">${formatDate(n.created_at)}</div>
                </div>
            `).join('');
        } catch (error) {
            list.innerHTML = '<div class="notif-empty">Could not load notifications.</div>';
        }
    }

    document.getElementById('notif-btn').addEventListener('click', (event) => {
        event.stopPropagation();
        panel.classList.toggle('hidden');
        if (!panel.classList.contains('hidden')) loadNotifications();
    });

    panel.addEventListener('click', (event) => event.stopPropagation());

    document.addEventListener('click', () => panel.classList.add('hidden'));

    list.addEventListener('click', async (event) => {
        const item = event.target.closest('.notif-item');
        if (!item || item.dataset.id === undefined) return;
        if (!item.classList.contains('unread')) return;

        item.classList.remove('unread');
        await fetch(`/api/dashboard/notifications/${item.dataset.id}/read`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${token}` }
        });
        loadNotifications();
    });

    document.getElementById('notif-read-all').addEventListener('click', async (event) => {
        event.stopPropagation();
        await fetch('/api/dashboard/notifications/read-all', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` }
        });
        loadNotifications();
    });

    loadNotifications();
}

// Export for use in other pages
window.app = {
    apiCall,
    currentUser,
    authToken,
    formatDate,
    escapeHtml,
    getStatusBadgeClass,
    getPriorityBadgeClass,
    showToast,
    initNotificationBell
};
