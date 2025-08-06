const Ably = require('ably');
require('dotenv').config();

let client = null;
let presenceChannel = null;
let userId = null;

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

// Update presence data with the new status
async function publishStatusUpdate(status) {
  if (!presenceChannel || !client || client.connection.state !== 'connected') {
    console.warn(`⚠️ Ably not ready, cannot update presence status: ${status}`);
    return;
  }

  try {
    
    // Update the presence data for the current user
    await presenceChannel.presence.update({ status });
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

