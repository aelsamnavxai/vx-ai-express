
import axios from "axios";
import { Client } from "@microsoft/microsoft-graph-client";

export const revokeOutlookToken = async (
    refreshToken,
    subscriptionId,
    accessToken
) => {
    try {
        const revokeUrl =
            "https://login.microsoftonline.com/common/oauth2/v2.0/token";

        await axios.post(
            revokeUrl,
            new URLSearchParams({
                token: refreshToken,
                token_type_hint: "refresh_token",
            }).toString(),
            {
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
            }
        );

        await axios.delete(
            `https://graph.microsoft.com/v1.0/subscriptions/${subscriptionId}`,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            }
        );
        console.log("Outlook Pub/Sub subscription stopped successfully");
    }
    catch (error) {
        console.error("Error revoking Outlook token:", error);
    }

  };



export const refreshOutlookAccessToken = async (refreshToken) => {
    try {
        const tokenParams = new URLSearchParams({
            client_id: process.env.MICROSOFT_CLIENT_ID || "",
            client_secret: process.env.MICROSOFT_CLIENT_SECRET || "",
            refresh_token: refreshToken,
            grant_type: "refresh_token",
        });

        const response = await axios.post(
            "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            tokenParams.toString(),
            {
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
            }
        );

        return response.data; // includes access_token, refresh_token, expires_in
    } catch (error) {
        console.error('❌ Failed to refresh access token:', error.response?.data || error.message);
        return null;
    }
};



//get threadId and messageId for Outlook
export const getOutlookThreadMessageId = async (accessToken, senderEmail) => {
    try {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) {
            throw new Error("Invalid email address format.");
        }

        const client = Client.init({
            authProvider: (done) => done(null, accessToken),
        });

        // Use full-text search to find messages from the sender
        const response = await client
            .api('/me/messages')
            .search(`"from:${senderEmail}"`) // full-text search
            .top(50) // get more items to ensure we find older emails
            .select('id,conversationId,subject,from,sentDateTime')
            .get();

        if (!response.value || response.value.length === 0) {
            throw new Error("No messages found from the specified sender.");
        }

        // Sort manually to get the latest message
        const sorted = response.value.sort((a, b) =>
            new Date(b.sentDateTime).getTime() - new Date(a.sentDateTime).getTime()
        );

        const latestMessage = sorted[0];

        return {
            threadId: latestMessage.conversationId,
            messageID: latestMessage.id,
            subjectLine: latestMessage.subject || '[No Subject]',
        };
    } catch (error) {
        console.error("Error fetching threadId and Message-ID To send FollowUp:", error instanceof Error ? error.message : error);
        return {
            threadId: "",
            messageID: "",
            subjectLine: ""
        };
    }
};



export async function sendOutlookEmail({
    accessToken,
    to,
    subject,
    content,
    cc = '',
    bcc = '',
    messageId = '',
    customLabel = '',
    mode = 'send',
    conversationId = '', // Added for forward mode
    attachments = [], // Added attachments parameter
}) {
    let returnMessageId = '';
    try {
        const client = Client.init({
            authProvider: (done) => {
                done(null, accessToken);
            },
        });

        if (customLabel) {
            await isCategoryAvailable(accessToken, customLabel);
        }

        let messageBody = content;
        let allAttachments = [...attachments];

        // Handle forward mode
        if (mode === 'forward' && messageId) {
            // Fetch the original message
            const message = await client.api(`/me/messages/${messageId}`)
                .select('from,subject,receivedDateTime,body,attachments')
                .get();

            // Extract message details
            const from = message.from?.emailAddress?.address || 'Unknown';
            const date = message.receivedDateTime || 'Unknown';
            const originalSubject = message.subject || 'No Subject';
            const originalBody = message.body?.content || '';

            // Fetch attachments from the original message
            const originalAttachments = message.attachments || [];
            for (const attachment of originalAttachments) {
                if (attachment.contentBytes) {
                    allAttachments.push({
                        filename: attachment.name || 'attachment',
                        content: attachment.contentBytes, // Already base64-encoded
                        contentType: attachment.contentType || 'application/octet-stream',
                    });
                }
            }

            // Format forwarded message
            const forwardedContent = `
                <p>${content}</p>
                <br><br>
                <p>---------- Forwarded message ----------</p>
                <div style="border-left: 2px solid #ccc; padding-left: 10px;">
                    <p><b>From:</b> ${from}</p>
                    <p><b>Date:</b> ${date}</p>
                    <p><b>Subject:</b> ${originalSubject}</p>
                    <br>
                    ${originalBody}
                </div>
            `;
            messageBody = forwardedContent;
        }

        if (mode === 'reply' && messageId) {
            // Reply mode: Use the existing reply endpoint
            const res = await client.api(`/me/messages/${messageId}/reply`).post({
                comment: content,
            });
            returnMessageId = res.id;
            console.log('Reply sent successfully via Outlook');
        } else {
            // Send or forward mode: Construct a new message
            const encodeSubject = (text) => Buffer.from(text, 'utf8').toString();

            const message = {
                message: {
                    subject: encodeSubject(subject),
                    body: {
                        contentType: 'HTML',
                        content: messageBody,
                    },
                    toRecipients: [
                        {
                            emailAddress: {
                                address: to,
                            },
                        },
                    ],
                    ccRecipients: cc
                        ? cc.split(',').map((email) => ({
                            emailAddress: { address: email.trim() },
                        }))
                        : [],
                    bccRecipients: bcc
                        ? bcc.split(',').map((email) => ({
                            emailAddress: { address: email.trim() },
                        }))
                        : [],
                    attachments: allAttachments.map(attachment => ({
                        '@odata.type': '#microsoft.graph.fileAttachment',
                        name: attachment.filename,
                        contentBytes: attachment.content.replace(/^data:[\w\/]+;base64,/, ''), // Remove data URI prefix
                        contentType: attachment.contentType,
                    })),
                },
                saveToSentItems: true,
            };

            const res = await client.api('/me/sendMail').post(message);
            returnMessageId = res.id || '';
            console.log(`${mode === 'forward' ? 'Forwarded' : 'Email'} sent successfully via Outlook`);
        }

        // If a custom label is provided, apply it
        if (customLabel) {
            if (returnMessageId) {
                await applyCategoryToEmail(accessToken, returnMessageId, customLabel);
            } else {
                const sentEmailId = await getLastSentEmailId(accessToken);
                if (sentEmailId) {
                    await applyCategoryToEmail(accessToken, sentEmailId, customLabel);
                }
            }
        }

        return { success: true };
    } catch (error) {
        console.error('Error sending email:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}

async function applyCategoryToEmail(accessToken, messageId, category) {
    try {
        const client = Client.init({
            authProvider: (done) => done(null, accessToken),
        });

        await client.api(`/me/messages/${messageId}`).patch({
            categories: [category],
        });

        console.log(`Category "${category}" applied successfully.`);
        return { success: true };
    } catch (error) {
        console.error('Error applying category:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}


async function getLastSentEmailId(accessToken) {
    try {
        const client = Client.init({
            authProvider: (done) => done(null, accessToken),
        });

        const response = await client
            .api('/me/mailFolders/sentitems/messages')
            .orderby('sentDateTime DESC') // Get the latest email
            .top(1) // Fetch only one email
            .select('id') // Only get the message ID
            .get();

        if (response?.value?.length > 0) {
            return response.value[0].id;
        } else {
            console.warn('No sent email found.');
            return null;
        }
    } catch (error) {
        console.error('Error retrieving sent email:', error);
        return null;
    }
}



async function isCategoryAvailable(accessToken, categoryName) {
    const client = Client.init({
        authProvider: (done) => done(null, accessToken),
    });

    try {
        // Fetch existing categories
        const categories = await client.api('/me/outlook/masterCategories').get();
        const categoryExists = categories.value.some(cat => cat.displayName === categoryName);

        console.log(`Category "${categoryName}" exists:`, categoryExists);

        if (!categoryExists) {
            // Create category if it doesn't exist
            await client.api('/me/outlook/masterCategories').post({
                displayName: categoryName,
                color: 'preset0', // You can choose different colors
            });

            console.log(`Category "${categoryName}" created successfully.`);
        }
    } catch (error) {
        console.error('Error ensuring category exists:', error);
    }
}