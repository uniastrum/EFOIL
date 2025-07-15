document.addEventListener('DOMContentLoaded', async () => {
  await loadUsers();
  await initUserSelect();

  // Добавление пользователя
  document.getElementById('add-user-form').addEventListener('submit', handleAddUser);

  // Добавление устройства
  document.getElementById('add-device-form').addEventListener('submit', handleAddDevice);
});

// Загрузка пользователей
async function loadUsers() {
  try {
    const response = await fetch('/api/users');
    const users = await response.json();
    renderUsers(users);
  } catch (error) {
    console.error('Error loading users:', error);
  }
}

// Отображение пользователей
function renderUsers(users) {
  const usersList = document.getElementById('users-list');
  usersList.innerHTML = users.map(user => `
    <div class="user-card" data-id="${user.id}">
      <div class="user-header">
        <h3>${user.name}</h3>
        <span>ID: ${user.telegram_id}</span>
      </div>
      <div class="user-actions">
        <button class="edit-btn" onclick="editUser(${user.id})">✏️</button>
        <button class="delete-btn" onclick="deleteUser(${user.id})">🗑️</button>
      </div>
      ${renderDevices(user.devices)}
    </div>
  `).join('');
}

// Отображение устройств
function renderDevices(devices) {
  if (!devices) return '';
  return `
    <div class="devices-list">
      <h4>Devices:</h4>
      ${devices.split(',').map(device => `
        <div class="device">
          <span>${device}</span>
          <button onclick="deleteDevice('${device}')">Delete</button>
        </div>
      `).join('')}
    </div>
  `;
}

// Обработчики действий
async function editUser(userId) {
  const newName = prompt('Enter new name:');
  if (newName) {
    try {
      await fetch(`/api/users/${userId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName })
      });
      await loadUsers();
    } catch (error) {
      console.error('Error updating user:', error);
    }
  }
}

async function deleteUser(userId) {
  if (confirm('Are you sure you want to delete this user?')) {
    try {
      await fetch(`/api/users/${userId}`, { method: 'DELETE' });
      await loadUsers();
    } catch (error) {
      console.error('Error deleting user:', error);
    }
  }
}

async function deleteDevice(deviceId) {
  if (confirm('Delete this device?')) {
    try {
      await fetch(`/api/devices/${deviceId}`, { method: 'DELETE' });
      await loadUsers();
    } catch (error) {
      console.error('Error deleting device:', error);
    }
  }
}

// Остальные функции остаются без изменений...
