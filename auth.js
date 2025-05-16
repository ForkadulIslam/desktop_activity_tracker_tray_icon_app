const SERVER_URL = window.env.SERVER_URL;

const loginForm = document.getElementById('login-form');
const userInfo = document.getElementById('user-info');
const status = document.getElementById('status');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('login-btn');
const logoutBtn = document.getElementById('logout-btn');
const displayName = document.getElementById('display-name');


const punchInBtn = document.getElementById('punch-in-btn');
const punchOutBtn = document.getElementById('punch-out-btn');
const breakStartBtn = document.getElementById('break-start-btn');
const breakEndBtn = document.getElementById('break-end-btn');
const closeButton = document.getElementById('action-button-close');

let currentStatus = {
  punchedIn: false,
  onBreak: false,
};

async function safeFetch(url, options) {
  try {
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Something went wrong');
    return data;
  } catch (err) {
    console.error(`Error in ${url}:`, err);
    status.textContent = err.message;
    throw err;
  }
}

async function getUserStatus(session) {
  try{
    const response = await safeFetch(`${SERVER_URL}/userStatus?user_id=${session.userId}`);
    currentStatus = {
      punchedIn: response.data.punchedIn,
      onBreak: response.data.onBreak,
    };
    return currentStatus;
  }catch(e){
    console.error(`Error in getUserStatus request`, e);
  }
}

//User Punch status
(async () => {
  const session = await window.electronAPI.getSession();
  if (session?.userId && session?.name) {
    displayName.textContent = session.name;
    loginForm.classList.add('hidden');
    userInfo.classList.remove('hidden');
    await getUserStatus(session);
    updateButtonStates();
  }
  window.electronAPI.getAppVersion().then(version => {
    document.getElementById('version').textContent = `v ${version}`;
  });

})();

punchInBtn.addEventListener('click', async () => {
  //console.log('Punch in click');
  const session = await window.electronAPI.getSession();
  if (!session?.userId) return;

  try {
    const response = await safeFetch(`${SERVER_URL}/punch-in`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'user-id': session.userId,
      },
    });
    if (response.success) {
      currentStatus.punchedIn = true;
      currentStatus.onBreak = false; // Reset break status
      updateButtonStates();
      status.textContent = 'Successfully punched in.';
    }
  } catch (err) {
    console.error('Punch In Error:', err);
  }

});
punchOutBtn.addEventListener('click', async () => {
  
  const session = await window.electronAPI.getSession();
  if (!session?.userId) return;

  try {
    const response = await safeFetch(`${SERVER_URL}/punch-out`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'user-id': session.userId,
      },
    });
    if (response.success) {
      currentStatus.punchedIn = false;
      currentStatus.onBreak = false;
      updateButtonStates();
      status.textContent = 'Successfully punched out.';
    }
  } catch (err) {
    console.error('Punch Out Error:', err);
  }

});
breakStartBtn.addEventListener('click', async () => {
  const session = await window.electronAPI.getSession();
  if (!session?.userId) return;

  try {
    const response = await safeFetch(`${SERVER_URL}/break-start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'user-id': session.userId,
      },
    });

    status.textContent = response.message || 'Break started successfully.';
    currentStatus.onBreak = true;
    updateButtonStates();
  } catch (err) {
    console.error('Break start failed:', err);
  }
});

breakEndBtn.addEventListener('click', async () => {
  const session = await window.electronAPI.getSession();
  if (!session?.userId) return;

  try {
    const response = await safeFetch(`${SERVER_URL}/break-end`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'user-id': session.userId,
      },
    });

    status.textContent = response.message || 'Break ended successfully.';
    currentStatus.onBreak = false;
    updateButtonStates();
  } catch (err) {
    console.error('Break end failed:', err);
  }
});

closeButton.addEventListener('click', () => {
  window.close(); // or send a message to main process via IPC
});

loginBtn.addEventListener('click', async () => {
  
  const username = usernameInput.value.trim();
  const password = passwordInput.value;

  status.textContent = '';

  if (!username || !password) {
    status.textContent = 'Username and password are required.';
    return;
  }

  loginBtn.disabled = true;

  try {
    const response = await fetch(`${SERVER_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    const data = await response.json(); 
    if (response.ok && data.success) {
      let sessionData = { userId: data.user_id, name: data.name };
      window.electronAPI.sendLoginSuccess(sessionData);
      await getUserStatus(sessionData);
      showLoggedInUI(data.name);
    } else {
      status.textContent = data.message || 'Login failed';
    }
    loginBtn.disabled = false;
  } catch (error) {
    console.error('Login error:', error);
    status.textContent = 'An error occurred. Please try again later.';
    loginBtn.disabled = false;
  }
});

logoutBtn.addEventListener('click', () => {
  status.textContent = '';
  window.electronAPI.sendLogout();
  showLoginForm();
});




  
  function showLoggedInUI(name) {
    displayName.textContent = name;
    loginForm.classList.add('hidden');
    userInfo.classList.remove('hidden');
    updateButtonStates({}); // Optional: pass user punch status later
  }
  
  function showLoginForm() {
    loginForm.classList.remove('hidden');
    userInfo.classList.add('hidden');
    usernameInput.value = '';
    passwordInput.value = '';
  }
  

  function updateButtonStates() {
    if (!currentStatus.punchedIn) {
      punchInBtn.classList.remove('hidden');
      punchOutBtn.classList.add('hidden');
      breakStartBtn.classList.add('hidden');
      breakEndBtn.classList.add('hidden');
    } else {
      punchInBtn.classList.add('hidden');
      punchOutBtn.classList.remove('hidden');
  
      if (!currentStatus.onBreak) {
        breakStartBtn.classList.remove('hidden');
        breakEndBtn.classList.add('hidden');
      } else {
        punchOutBtn.classList.add('hidden');
        breakStartBtn.classList.add('hidden');
        breakEndBtn.classList.remove('hidden');
      }
    }
  }
