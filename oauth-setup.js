// Temporary OAuth setup helper - adds /oauth/callback route to exchange code for refresh token
// This file is imported by server.js temporarily during setup
// DELETE this file after getting the refresh token

'use strict';
const axios = require('axios');

module.exports = function setupOAuthCallback(app) {
    app.get('/oauth/callback', async (req, res) => {
          const { code, error } = req.query;

                if (error) {
                        return res.send('<h2>OAuth Error: ' + error + '</h2>');
                }

                if (!code) {
                        return res.send('<h2>No code received</h2>');
                }

                try {
                        const tokenRes = await axios.post(
                                  'https://accounts.zoho.in/oauth/v2/token',
                                  null,
                          {
                                      params: {
                                                    code,
                                                    client_id: process.env.ZOHO_CLIENT_ID,
                                                    client_secret: process.env.ZOHO_CLIENT_SECRET,
                                                    redirect_uri: process.env.ZOHO_REDIRECT_URI || 'https://zoho-retell-middleware-production.up.railway.app/oauth/callback',
                                                    grant_type: 'authorization_code'
                                      }
                          }
                                );

            const data = tokenRes.data;

            if (data.refresh_token) {
                      res.send(`
                                <html><body style="font-family:monospace;padding:20px;">
                                          <h2 style="color:green">SUCCESS! Copy your Refresh Token:</h2>
                                                    <pre style="background:#f0f0f0;padding:15px;font-size:16px;word-break:break-all;">${data.refresh_token}</pre>
                                                              <p><strong>Access Token</strong> (expires in ${data.expires_in}s):</p>
                                                                        <pre style="background:#f0f0f0;padding:10px;font-size:12px;word-break:break-all;">${data.access_token}</pre>
                                                                                  <p style="color:red;">Set ZOHO_REFRESH_TOKEN in Railway Variables to the value above, then redeploy.</p>
                                                                                            </body></html>
                                                                                                    `);
            } else {
                      res.send('<pre>' + JSON.stringify(data, null, 2) + '</pre>');
            }
                } catch (err) {
                        res.send('<h2>Error</h2><pre>' + (err.response ? JSON.stringify(err.response.data, null, 2) : err.message) + '</pre>');
                }
    });
};
