const Ably = require('ably');
require('dotenv').config();

let client = null;
let presenceChannel = null;
let userId = null;
const SERVER_URL =process.env.SERVER_URL;
function initPresence(id) {
  if (!id) return;

  userId = id;

  client = new Ably.Realtime({
    key: process.env.ABLY_API_KEY,
    clientId: `tracker-${userId}`
  });

  presenceChannel = client.channels.get('tracker-presence');

  client.connection.on('connected', async () => {
    console.log('🟢 Ably connected for presence');
    try {
      // Enter presence with initial data
      await presenceChannel.presence.enter({
        userId,
        firstSeen: Date.now(),
        status: 'online'
      });
      console.log(`✅ User ${userId} entered presence channel`);

    } catch (err) {
      console.error('❌ Presence enter failed:', err);
    }
  });


  client.connection.on('disconnected', () => {
    console.log('⚠️ Ably disconnected');
  });
  
  client.connection.on('reconnected', async () => {
    console.log('🔄 Reconnected — rejoining presence');
    try {
      
      await presenceChannel.presence.enter({
        userId,
        reconnectedAt: Date.now(),
        status: 'online'
      });

    } catch (err) {
      console.error('❌ Re-entering presence failed:', err);
    }
  });

  client.connection.on('failed', () => {
    console.log('🔴 Ably connection failed');
  });

  // Graceful shutdown
  const shutdown = async () => {
    try {
      
      if (presenceChannel) {
        await presenceChannel.presence.leave({
          userId,
          lastSeen: Date.now(),
          status: 'offline'
        });
        console.log(`🔴 User ${userId} left presence channel`);
      }

      if (client) {
        client.close();
      }
      console.log('🔴 Tracker offline');
    } catch (err) {
      console.error('❌ Error during shutdown:', err);
    }
    process.exit();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', shutdown);
}


function leavePresence() {
  if (presenceChannel) {
    presenceChannel.presence.leave({
      userId,
      lastSeen: Date.now(),
      status: 'offline'
    }).catch(err => {
      console.error('❌ Error leaving presence:', err);
    });
    presenceChannel = null;
  }
}


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
// Update presence data with the new status
async function publishStatusUpdate(status) {
  if (!presenceChannel || !client || client.connection.state !== 'connected') {
    console.warn(`⚠️ Ably not ready, cannot update presence status: ${status}`);
    return;
  }    

  try {
    
    const response = await safeFetch(`${SERVER_URL}/userStatus?user_id=${userId}`);
    currentStatus = {
      punchedIn: response.data.punchedIn,
      onBreak: response.data.onBreak,
    };
    console.log(currentStatus);


    // Update the presence data for the current user
    if(status == 'idle'){
      if(currentStatus.punchedIn === true && currentStatus.onBreak === false){
        await presenceChannel.presence.update({ status });
      }
    }else{
      await presenceChannel.presence.update({ status });
    }
    console.log(`📢 Updated presence status to: ${status}`);
  } catch (err) {
    console.error(`❌ Failed to update presence status:`, err);
  }
}

module.exports = {
  initPresence,
  leavePresence,
  publishStatusUpdate
};

