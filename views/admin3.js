<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>EFOIL Admin Panel</title>
  <style>
    body { font-family: sans-serif; background: #f5f5f5; padding: 20px; }
    h1, h2, h3 { color: #333; }
    table { width: 100%; border-collapse: collapse; margin-top: 0px; background: white; }
    th, td { padding: 10px; border: 1px solid #ddd; text-align: left; }
    th { background: #eee; }
    form.inline { display: inline; margin: 0 5px; }
    input[type="text"] { padding: 5px; width: 150px; }
    button, a.button-link {
      padding: 5px 10px;
      background: #2196F3;
      color: white;
      text-decoration: none;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    a.button-link { display: inline-block; }
    button:hover, a.button-link:hover { background: #1976D2; }
    .esp-item { display: inline-block; margin-right: 5px; }
    .delete-esp { background: #f44336; margin-left: 0px; }
    .delete-esp:hover { background: #d32f2f; }
    .name-display { padding: 5px; display: inline-block; width: 150px; }
    .action-buttons { display: flex; gap: 5px; flex-wrap: wrap; }
  </style>
</head>
<body>
  <h1>EFOIL Admin</h1>
  <% if (error) { %>
    <div style="color: red; margin-bottom: 15px;"><%= error %></div>
  <% } %>
  
  <form method="POST" action="/add-user" style="margin-bottom: 20px;">
    <input type="text" name="name" placeholder="User name" required />
    <input type="text" name="telegram_id" placeholder="Telegram ID" required />
    <button type="submit">Add User</button>
  </form>

  <table>
    <thead>
      <tr>
        <th>Name</th>
        <th>Telegram ID</th>
        <th>Boats (ESP32)</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody>
      <% users.forEach(user => { %>
        <tr>
          <td>
            <div class="name-display"><%= user.name || 'Not specified' %></div>
          </td>
          <td><%= user.telegram_id %></td>
          <td>
            <% if (user.esp_list) { %>
              <% user.esp_list.split(', ').forEach(esp => { %>
                <div class="esp-item">
                  <%= esp %>
                  <form class="inline" method="POST" action="/delete-device">
                    <input type="hidden" name="user_id" value="<%= user.id %>" />
                    <input type="hidden" name="esp_number" value="<%= esp %>" />
                    <button class="delete-esp" type="submit">×</button>
                  </form>
                </div>
              <% }) %>
            <% } else { %>
              No boats
            <% } %>
          </td>
          <td>
            <div class="action-buttons">
              <form method="POST" action="/delete-user">
                <input type="hidden" name="user_id" value="<%= user.id %>" />
                <button>Delete</button>
              </form>
              <form method="POST" action="/add-device">
                <input type="hidden" name="user_id" value="<%= user.id %>" />
                <input type="text" name="esp_number" placeholder="ESP Number" required />
                <button>Add Boat</button>
              </form>
              <a class="button-link" href="/history?user_id=<%= user.id %>">History</a>
              <a class="button-link" href="/export-csv?user_id=<%= user.id %>">📥 CSV</a>
            </div>
          </td>
        </tr>
      <% }) %>
    </tbody>
  </table>
</body>
</html>