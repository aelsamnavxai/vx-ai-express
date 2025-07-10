
import { google } from "googleapis";
import axios from "axios";

export const revokeGoogleToken = async (accessToken) => {
    try {
        // Step 1: Remove Gmail Pub/Sub Watch Subscription
        await axios("https://www.googleapis.com/gmail/v1/users/me/stop", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
            },
        });
        console.log("Google Pub/Sub subscription stopped successfully");

        const revokeUrl = `https://oauth2.googleapis.com/revoke?token=${accessToken}`;
        await axios(revokeUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
    } catch (error) {
        console.error("Error revoking Google token:", error);
    }

  };


export const getThreadMessageId = async (oauth2Client, email) => {
    try {
        const gmail = google.gmail({ version: "v1", auth: oauth2Client });

        // Fetch the latest email **sent** to the given email address
        const response = await gmail.users.messages.list({
            userId: 'me',
            q: `from:${email}`,
            maxResults: 1,
        });

        if (!response.data.messages || response.data.messages.length === 0) {
            throw new Error("No messages found for this email.");
        }

        const latestMessage = response.data.messages[0];
        const threadId = latestMessage.threadId;
        const messageId = latestMessage.id;



        if (!threadId || !messageId) {
            throw new Error("Thread ID or Message-ID not found.");
        }

        // Fetch the full email details to extract headers
        const messageDetails = await gmail.users.messages.get({
            userId: "me",
            id: messageId,
        });

        // print message body

        // Extract `Message-ID` from headers
        const messageID =
            messageDetails.data.payload?.headers?.find(
                (header) => header.name === "Message-Id" || header.name === "Message-ID"
            )?.value || "";
        const subjectLine = messageDetails.data.payload?.headers?.find(
            (header) => header.name === "Subject"
        )?.value || "";




        return {
            threadId,
            messageID, // The actual Message-ID from headers.
            subjectLine
        };
    } catch (error) {
        console.error("Error fetching threadId and Message-ID:", error instanceof Error ? error.message : error);
        return {
            threadId: "",
            messageID: "",
            subjectLine: ""
        };
    }
};



export async function sendGoogleEmail({
    oauth2Client,
    to,
    subject,
    content,
    cc = '',
    bcc = '',
    mode = 'send',
    threadId = '',
    inReplyTo = '',
    customLabel = '',
    attachments = [],
}) {
    console.log('Subject:', subject);
    try {
        // Create a unique boundary for multipart message
        const boundary = 'xai_email_boundary_' + Date.now();
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

        // Build email headers
        const emailHeaders = [
            `Content-Type: multipart/mixed; boundary="${boundary}"`,
            'MIME-Version: 1.0',
            `To: ${to}`,
            cc ? `Cc: ${cc}` : '',
            bcc ? `Bcc: ${bcc}` : '',
            `Subject: =?utf-8?B?${Buffer.from(subject).toString('base64')}?=`,
            mode === 'reply' && inReplyTo ? `In-Reply-To: ${inReplyTo}` : '',
            mode === 'reply' && inReplyTo ? `References: ${inReplyTo}` : '',
        ].filter(Boolean);

        // Initialize email parts
        const emailParts = [];

        // Handle forward mode: Fetch thread messages and include them
        let forwardedContent = content;
        let allAttachments = [...attachments];

        if (mode === 'forward' && threadId) {
            // Fetch the thread
            const threadResponse = await gmail.users.threads.get({
                userId: 'me',
                id: threadId,
                format: 'full',
            });

            const messages = threadResponse.data.messages || [];
            const forwardedMessages= [];
            const threadAttachments = [];
            // Process each message in the thread
            for (const message of messages) {
                const headers = message.payload?.headers || [];
                const from = headers.find(h => h?.name?.toLowerCase() === 'from')?.value || 'Unknown';
                const date = headers.find(h => h?.name?.toLowerCase() === 'date')?.value || 'Unknown';
                const subject = headers.find(h => h?.name?.toLowerCase() === 'subject')?.value || 'No Subject';

                // Extract message body
                let body = '';
                if (message.payload?.parts) {
                    for (const part of message.payload.parts) {
                        if (part.mimeType === 'text/plain' || part.mimeType === 'text/html') {
                            body = Buffer.from(part.body?.data || '', 'base64').toString('utf-8');
                            break;
                        }
                    }
                } else if (message.payload?.body?.data) {
                    body = Buffer.from(message.payload.body.data, 'base64').toString('utf-8');
                }

                // Format forwarded message
                forwardedMessages.push(`
                    <br><br>
                    <div style="border-left: 2px solid #ccc; padding-left: 10px;">
                        <p><b>From:</b> ${from}</p>
                        <p><b>Date:</b> ${date}</p>
                        <p><b>Subject:</b> ${subject}</p>
                        <br>
                        ${body}
                    </div>
                `);

                if (message.payload?.parts) {
                    for (const part of message.payload.parts) {
                        if (part.filename && part.body?.attachmentId) {
                            const attachmentResponse = await gmail.users.messages.attachments.get({
                                userId: 'me',
                                messageId: message.id || '',
                                id: part.body.attachmentId,
                            });
                            threadAttachments.push({
                                filename: part.filename,
                                content: attachmentResponse.data.data || '',
                                contentType: part.mimeType || 'application/octet-stream',
                            });
                        }
                    }
                }
            }

            forwardedContent = `
                ${content}
                <br><br>
                <p>---------- Forwarded message ----------</p>
                ${forwardedMessages.join('<hr>')}
            `;
            allAttachments = [...allAttachments, ...threadAttachments];
        }

        // Helper function to encode content as quoted-printable
        // Helper function to encode content as quoted-printable
        const encodeQuotedPrintable = (text) => {
            // Normalize line breaks to CRLF before encoding
            const normalizedText = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');

            // Convert the input string to a Buffer to handle UTF-8 encoding
            const buffer = Buffer.from(normalizedText, 'utf-8');
            let encoded = '';

            // Step 1: Encode the content byte-by-byte
            for (let i = 0; i < buffer.length; i++) {
                const byte = buffer[i];
                // Printable ASCII characters (0x20 to 0x7E) are kept as-is, except for '='
                if (byte >= 0x20 && byte <= 0x7E && byte !== 0x3D) {
                    encoded += String.fromCharCode(byte);
                } else {
                    // Non-printable or special characters are encoded as =XX
                    encoded += '=' + byte.toString(16).padStart(2, '0').toUpperCase();
                }
            }

            // Step 2: Split lines for quoted-printable compliance (lines < 76 chars)
            const lines = [];
            let currentLine = '';
            let i = 0;

            while (i < encoded.length) {
                // Check if we're at the start of an encoded sequence (e.g., =E2)
                if (encoded[i] === '=' && i + 5 <= encoded.length && encoded[i + 3] === '=') {
                    // This is an encoded sequence like =E2=80=93 (6 characters)
                    const sequence = encoded.substr(i, 6); // e.g., =E2=80=93
                    if (currentLine.length + sequence.length > 73) {
                        // If adding the sequence exceeds the line length, start a new line
                        lines.push(currentLine + '=');
                        currentLine = '';
                    }
                    currentLine += sequence;
                    i += 6;
                } else {
                    // Regular character
                    if (currentLine.length >= 73) {
                        lines.push(currentLine + '=');
                        currentLine = '';
                    }
                    currentLine += encoded[i];
                    i++;
                }
            }

            if (currentLine) {
                lines.push(currentLine);
            }

            return lines.join('\r\n');
        };


        // Optional: Replace en dash with hyphen to avoid encoding issues
        forwardedContent = forwardedContent.replace(/–/g, '-');

        // Ensure HTML content is properly formatted and encoded
        emailParts.push(
            `--${boundary}`,
            'Content-Type: text/html; charset=utf-8',
            'Content-Transfer-Encoding: quoted-printable',
            '',
            encodeQuotedPrintable(forwardedContent)
        );


        // Add attachments
        if (allAttachments.length > 0) {
            allAttachments.forEach((attachment) => {
                emailParts.push(
                    `--${boundary}`,
                    `Content-Type: ${attachment.contentType}`,
                    `Content-Disposition: attachment; filename="${attachment.filename}"`,
                    'Content-Transfer-Encoding: base64',
                    '',
                    attachment.content.replace(/^data:[\w\/]+;base64,/, '')
                );
            });
        }

        emailParts.push(`--${boundary}--`);

        const emailContent = [...emailHeaders, '', ...emailParts].join('\r\n');

        const encodedEmail = Buffer.from(emailContent)
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');

        const requestBody = {
            raw: encodedEmail,
        };

        if (mode === 'reply' && threadId) {
            requestBody.threadId = threadId;
        }

        const response = await gmail.users.messages.send({
            userId: 'me',
            requestBody,
        });

        const messageId = response.data.id;

        if (customLabel && messageId) {
            await applyLabelToMessage(oauth2Client, messageId, customLabel);
        }

        return { success: true, messageId: response.data };
    } catch (error) {
        console.error('Error sending email via Gmail:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
}


async function applyLabelToMessage(oauth2Client, messageId, labelName) {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Fetch the existing labels
    const existingLabels = await gmail.users.labels.list({ userId: 'me' });
    let label = existingLabels.data.labels?.find((l) => l.name === labelName);

    // If the label doesn't exist, create it
    if (!label) {
        const newLabel = await gmail.users.labels.create({
            userId: 'me',
            requestBody: {
                name: labelName,
                labelListVisibility: 'labelShow',
                messageListVisibility: 'show',
            },
        });
        label = newLabel.data;
    }

    // Ensure label.id is a valid string
    if (!label.id) {
        throw new Error(`Failed to retrieve label ID for "${labelName}"`);
    }

    // Apply the label to the message
    await gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: {
            addLabelIds: [label.id], // Ensure label.id is a string
        },
    });

    console.log(`Label "${labelName}" applied to message ${messageId}`);
}
