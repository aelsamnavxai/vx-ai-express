
import { google } from "googleapis";
import { db } from "../config/firebase.js";
import { handleErrorLogging } from "../utils/index.js";
import { refreshOutlookAccessToken, revokeOutlookToken } from "./outlook.js";
import { revokeGoogleToken } from "./google.js";


export const getAuthenticatedOAuth2Client = async (businessId) => {
    let docData = null;
    let isUser = false;
    let docRef = null;

    try {
        console.log("Getting authenticated OAuth2 client for business:", businessId);

        // Fetch the business from the database
        const businessRef = db
            .collection("businesses")
            .doc(businessId);
        docRef = await businessRef.get();

        if (!docRef.exists) {
            //if no business is assosciated with the ID then search in users collection
            const userRef = db
                .collection("users")
                .doc(businessId);

            //update docRef to use the userRef
            //and set isUser to true
            docRef = await userRef.get();

            if (!docRef.exists) {
                console.error("No business or user found with this id:", businessId);
                throw new Error("No secondary user found with this id");
            }
            isUser = true;
        }

        docData = docRef.data();

        //if no auth provider is connected then return null
        if (!docData?.auth) {
            return {
                oauth2Client: null,
                access_token: "",
                provider: "none",
            }
        }

        const authToken = docData.auth ;
        const savedHistoryId = docData.historyId || "";

        if (!authToken.access_token || !authToken.refresh_token) {
            throw new Error(
                "Missing access token or refreh token. Please reconnect your account."
            );
        }

        const now = Date.now();
        const expiryBuffer = 10 * 60 * 1000; // 10 minutes buffer before token expiry

        const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            `${process.env.NEXT_PUBLIC_BASE_URL}/api/auth/google/callback`
        );

        // Check if the access token is expired or about to expire
        if (now + expiryBuffer >= authToken.expiry_date) {
            // Acquire lock to prevent concurrent refreshes
            const lockAcquired = await acquireTokenRefreshLock(businessId);
            if (!lockAcquired) {
                // Lock is already held by another process, so return the existing token
                //since we have 6 minute buffer, we can skip the refresh
                console.log("Another process is refreshing the token. Skipping refresh.");

                //set the credentials to the oauth2Client
                if (authToken.type === "google")
                    oauth2Client.setCredentials({ access_token: authToken.access_token });
                return {
                    oauth2Client,
                    access_token: authToken.access_token,
                    provider: authToken.type || "google",
                    refresh_token: authToken.refresh_token,
                    savedHistoryId,
                };
            }

            try {
                console.log("Access token expired, refreshing...");
                //token refresh logic
                if (authToken.type === "google") {

                    console.log("Refreshing Google access token using :", authToken.refresh_token);
                    // Refresh Google OAuth2 token
                    oauth2Client.setCredentials({
                        refresh_token: authToken.refresh_token,
                    });
                    const { credentials } = await oauth2Client.refreshAccessToken();

                    if (!credentials || !credentials.access_token) {
                        console.error("Google Access token not returned during refresh.");
                        throw new Error("Google Access token not returned during refresh.");
                    }
                    console.log("New access token:", credentials.access_token);
                    console.log("New expiry date:", credentials.expiry_date);

                    const newTokens = {
                        type: authToken.type,
                        access_token: credentials.access_token || authToken.access_token, // Keep old access token if none is returned
                        refresh_token: credentials.refresh_token,
                        expiry_date: credentials.expiry_date,
                    };

                    // Update the database with the new tokens
                    await db.collection(isUser ? "users" : "businesses").doc(businessId).update({ auth: newTokens });

                    console.log("Google access token refreshed successfully.");

                    // // Set new access token
                    // oauth2Client.setCredentials({ access_token: newTokens.access_token });
                    return {
                        oauth2Client,
                        access_token: "",
                        provider: "google",
                        refresh_token: "",
                        savedHistoryId,
                    };
                } else if (authToken.type === "outlook") {
                    // Refresh Outlook OAuth2 token 
                    const tokens = await refreshOutlookAccessToken(authToken.refresh_token);

                    if (!tokens.access_token) {
                        console.error("Oulook Access token not returned during refresh.");
                        throw new Error("Oulook Access token not returned during refresh.");
                    }

                    const newTokens = {
                        type: authToken.type,
                        access_token: tokens.access_token,
                        refresh_token: tokens.refresh_token || authToken.refresh_token, // Keep old refresh token if none is returned
                        expiry_date: now + tokens.expires_in * 1000, // Convert expires_in to timestamp
                    };

                    // Update the database with the new tokens
                    // await businessDoc.ref.update({ auth: newTokens });
                    await db.collection(isUser ? "users" : "businesses").doc(businessId).update({ auth: newTokens });

                    console.log("Outlook access token refreshed successfully.");

                    return {
                        oauth2Client: null, // No OAuth2 client for Outlook
                        access_token: newTokens.access_token,
                        provider: newTokens.type || "outlook",
                        refresh_token: newTokens.refresh_token,
                        savedHistoryId,
                    };
                } else {
                    // console.error("Unsupported authentication type:", authToken.type);
                    handleErrorLogging(new Error("Unsupported authentication type"), "getAuthenticatedOAuth2Client");
                }
            } catch (error) {
                console.error("Error refreshing access token:", error instanceof Error ? error.message : error);
                if (docData) {
                    //set auth to null in database for that user
                    console.log("Setting auth to null for business:", businessId);

                    if (docData.auth?.type === "google") {
                        console.log("Revoking Google token for business:", businessId);
                        await revokeGoogleToken(docData.auth.access_token).then(async () => {
                            await db
                                .collection(isUser ? "users" : "businesses")
                                .doc(businessId)
                                .update({ auth: null, connectedInbox: "" });
                        }
                        ).catch((error) => {
                            // console.error("Error revoking Google token:", error instanceof Error ? error.message : error);
                            handleErrorLogging(error, "revokeGoogleToken");
                        });
                    } else if (docData.auth?.type === "outlook") {
                        await revokeOutlookToken(
                            docData.auth.refresh_token,
                            docData.auth.subscriptionId,
                            docData.auth.access_token
                        ).then(async () => {
                            await db
                                .collection(isUser ? "users" : "businesses")
                                .doc(businessId)
                                .update({ auth: null, connectedInbox: "" });
                        }
                        ).catch((error) => {
                            // console.error("Error revoking Outlook token:", error instanceof Error ? error.message : error);
                            handleErrorLogging(error, "revokeOutlookToken");
                        }
                        );
                    }
                }
                //revoke the pub/sub watch subscription based on the provider
                throw new Error("Authentication error. Please reconnect your account.");
            } finally {
                // Release the lock after refreshing
                await releaseTokenRefreshLock(businessId);
            }
        }

        // Use the existing valid access token
        if (authToken.type === "google") {
            oauth2Client.setCredentials({ access_token: authToken.access_token, refresh_token: authToken.refresh_token });
            return {
                oauth2Client,
                access_token: "",
                provider: "google",
                refresh_token: "",
                savedHistoryId,
            };
        } else if (authToken.type === "outlook") {
            return {
                oauth2Client: null, // No OAuth2 client for Outlook
                access_token: authToken.access_token,
                provider: "outlook",
                refresh_token: authToken.refresh_token,
                savedHistoryId,
            };
        } else {
            throw new Error("Unsupported authentication type");
        }
    } catch (error) {
        console.error("Error getting authenticated OAuth2 client:", error);

        //if we have businessData then revoke the token

        throw new Error("Unable to get authenticated OAuth2 client");
    }
};
  



const acquireTokenRefreshLock = async (businessId) => {
    const LOCK_DOC_PATH = `locks/token-refresh-${businessId}`;
    const lockRef = db.doc(LOCK_DOC_PATH);
    const lockDoc = await lockRef.get();

    const now = Date.now();
    const lockExpirationBuffer = 1 * 60 * 1000; // Lock expires after 1 minute

    if (lockDoc.exists) {
        const lockData = lockDoc.data();
        if (lockData?.expiresAt && lockData.expiresAt > now) {
            // If the lock exists and hasn't expired yet, return false (indicating another process is refreshing)
            return false;
        }
    }

    // Acquire the lock by setting an expiration time
    await lockRef.set({
        expiresAt: now + lockExpirationBuffer,
    });

    return true; // Lock acquired successfully
};

const releaseTokenRefreshLock = async (businessId) => {
    const LOCK_DOC_PATH = `locks/token-refresh-${businessId}`;
    const lockRef = db.doc(LOCK_DOC_PATH);
    await lockRef.delete(); // Delete the lock document to release the lock
};
  