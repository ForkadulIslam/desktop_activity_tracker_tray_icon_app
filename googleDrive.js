const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const { BrowserWindow } = require('electron');
const { Readable } = require('stream');

// Credentials from .env file
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';
const FOLDER_NAME = 'Techvengers Screenshots';

const TOKEN_PATH = path.join(require('electron').app.getPath('userData'), 'google-drive-token.json');
const FOLDER_ID_PATH = path.join(require('electron').app.getPath('userData'), 'gdrive-folder-id.json');
const SCOPES = ['https://www.googleapis.com/auth/drive'];

let oauth2Client = null;
let folderId = null;
let authWindow = null; // Global to keep track of the auth window

function getOAuth2Client() {
    if (!oauth2Client) {
        oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
    }
    return oauth2Client;
}

async function loadToken() {
    if (fs.existsSync(TOKEN_PATH)) {
        try {
            const token = fs.readFileSync(TOKEN_PATH);
            const client = getOAuth2Client();
            client.setCredentials(JSON.parse(token));
            return client;
        } catch (err) {
            console.error('Error loading token:', err);
            if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH); // Corrupted token, delete it
        }
    }
    return null;
}

function saveToken(token) {
    try {
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
        console.log('Token saved to', TOKEN_PATH);
    } catch (err) {
        console.error('Error saving token:', err);
    }
}

function authorize() {
    return new Promise(async (resolve, reject) => {
        if (authWindow) {
            authWindow.focus();
            return reject(new Error('Authorization already in progress.'));
        }

        let client = await loadToken();
        if (client) {
            return resolve(client);
        }

        const authUrl = getOAuth2Client().generateAuthUrl({
            access_type: 'offline',
            scope: SCOPES,
            prompt: 'consent',
        });

        authWindow = new BrowserWindow({ width: 800, height: 600, show: true });
        authWindow.loadURL(authUrl);

        authWindow.on('closed', () => {
            authWindow = null;
            reject(new Error('Authorization window closed by user.'));
        });

        const onTitleChange = async (event, title) => {
            if (title.startsWith('Success code=')) {
                const code = title.substring('Success code='.length);
                authWindow.removeListener('page-title-updated', onTitleChange);
                authWindow.close();

                try {
                    const oAuth2Client = getOAuth2Client();
                    const { tokens } = await oAuth2Client.getToken(code);
                    oAuth2Client.setCredentials(tokens);
                    saveToken(tokens);
                    console.log('Google Drive: Authorization successful.');
                    resolve(oAuth2Client);
                } catch (err) {
                    console.error('Error getting token:', err);
                    reject(err);
                }
            } else if (title.startsWith('Denied error=')) {
                authWindow.removeListener('page-title-updated', onTitleChange);
                authWindow.close();
                reject(new Error('Authorization denied by user.'));
            }
        };

        authWindow.webContents.on('page-title-updated', onTitleChange);
    });
}

async function getFolderId(driveClient) {
    if (folderId) return folderId;
    if (fs.existsSync(FOLDER_ID_PATH)) {
        folderId = JSON.parse(fs.readFileSync(FOLDER_ID_PATH)).folderId;
        if(folderId) return folderId;
    }

    const response = await driveClient.files.list({
        q: `mimeType='application/vnd.google-apps.folder' and name='${FOLDER_NAME}' and trashed=false`,
        fields: 'files(id, name)',
    });

    if (response.data.files.length === 0) {
        // Create the folder if it doesn't exist
        const folderMetadata = {
            name: FOLDER_NAME,
            mimeType: 'application/vnd.google-apps.folder',
        };
        const file = await driveClient.files.create({
            resource: folderMetadata,
            fields: 'id',
        });
        folderId = file.data.id;
    } else {
        folderId = response.data.files[0].id;
    }

    fs.writeFileSync(FOLDER_ID_PATH, JSON.stringify({ folderId }));
    return folderId;
}

async function uploadScreenshot(buffer, fileName) {
    try {
        const authClient = await authorize();
        if (!authClient) {
            throw new Error('Login Required.');
        }
        const drive = google.drive({ version: 'v3', auth: authClient });
        const parentFolderId = await getFolderId(drive);

        const bufferStream = new Readable();
        bufferStream.push(buffer);
        bufferStream.push(null);

        await drive.files.create({
            requestBody: {
                name: fileName,
                mimeType: 'image/jpeg',
                parents: [parentFolderId],
            },
            media: {
                mimeType: 'image/jpeg',
                body: bufferStream,
            },
        });

        console.log(`✅ Screenshot uploaded to Google Drive folder "${FOLDER_NAME}"`);
        return true;
    } catch (err) {
        console.error(`❌ Google Drive upload failed: ${err.message}`);
        if (err.message.includes('invalid_grant')) {
            console.log('Invalid token. Deleting stored token. Please log in again.');
            if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
        }
        return false;
    }
}

module.exports = {
    authorize,
    uploadScreenshot,
};