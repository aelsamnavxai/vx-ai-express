import { adminSDK, db } from '../config/firebase';
import { getAuthenticatedOAuth2Client } from '../providers/shared';
import { getKnowledgeBaseData } from '../queries/shared';
import { format } from 'date-fns';
import { getThreadMessageId, sendGoogleEmail } from '../providers/google';
import { getOutlookThreadMessageId, sendOutlookEmail } from '../providers/outlook'
import { handleEmailSent } from '../queries/shared';
import {differenceInDays} from 'date-fns';
import { generateEmail } from './agent';
import { twilioClient, convertTwilioNumber } from '../utils/twilio';

const conversationsRef = db.collection('conversations');
const leadsRef = db.collection('leads');
const businessesRef = db.collection('businesses');


const formatForSms= (html) => {
    return html
        .replace(/<p>/g, '')             // Remove <p>
        .replace(/<\/p>/g, '\n')       // Replace </p> with double newline
        .replace(/<br\s*\/?>/g, '\n')    // Convert <br> to newline
        .replace(/<\/?[^>]+(>|$)/g, '')  // Fallback: remove any other HTML tags
        .trim();
}


//if no template data is available then use ai agent to genertae email

const getFollowUpStatus = (followUpSent) => {
    // Extract the follow-up number from the string
    const match = followUpSent.match(/follow_up_(\d+)$/);

    if (!match) return "Unknown";

    const followUpNumber = parseInt(match[1], 10);

    // Map the number to the appropriate text
    const statusMap = {
        1: "First Follow Up",
        2: "Second Follow Up",
        3: "Third Follow Up",
        4: "Fourth Follow Up",
        5: "Fifth Follow Up",
        6: "Sixth Follow Up",
        7: "Seventh Follow Up",
    };

    return (
        statusMap[followUpNumber] ||
        `Follow Up ${followUpNumber}`
    );
};
  

export const processDailyFollowUps = async () => {
    

    // 1. Get all businesses with active sales agents
    const businesses = await businessesRef
        .where('agents.sales_agent.status', '==', true)
        .get();

    if (businesses.empty) {
        console.log('No businesses with active sales agents');
        return;
    }

    console.log(`Found ${businesses.docs.length} businesses with active sales agents`);

    // 2. Process each business sequentially
    for (const businessDoc of businesses.docs) {
        const business = businessDoc.data();

        try {
            let oauth2Client = null;
            let access_token = null;
            let provider = null;

            if (!business.auth) {
                console.log(
                    "No connected inbox for this business",
                    business.businessEmail
                );
                return;
            }
            const { businessId, businessEmail, auth, aiSettings } = business;

            const { followUpTemplates, signature } = aiSettings;

            // every lead that is not in the following statuses: "Event Booked", "New Inquiry", "Lead Contacted" will be considered as inactive
            const leads = await leadsRef
                .where("user", "==", businessEmail)
                .where("status", "in", [
                    "New Inquiry",
                    "Lead Contacted",
                    "First Follow Up",
                    "Second Follow Up",
                    "Third Follow Up",
                    "Fourth Follow Up",
                    "Fifth Follow Up",
                    "Sixth Follow Up",
                ])
                .where("assignedTo", "==", "AI Sales Agent")
                .get();

            // if there are no leads to follow up, we will continue to the next business
            if (leads.empty) {
                console.log("No leads to follow up");
                return;
            }

            console.log("Leads to follow up", leads.docs.length);

            const { schedule, appointmentDuration, maxAppointments } = business

            const knowledgebase = await getKnowledgeBaseData(businessId);

            const { availableDates, freeText, bulkDates, questions, answers } = knowledgebase
            // const datesFormat = availableDates.map((date) => date.split("T")[0]).join(', ')
            const format_availableDates = availableDates.map(
                (date) => format(new Date(date.date), "do MMMM yyyy")
            );
            const docs = await fetch(
                `https://parsepdfforbusiness-preuz33amq-uc.a.run.app?businessId=${businessId}`
            ).then((res) => res.json());
            const knowledgebase_data = `
                   <knowledgebase>
                   This is the knowledgebase data for ${business.name}.
                   
                   <questions&answers>
                    ${questions.map((question, index) => {
                return `<question>${question}</question><answer>${answers[index]}</answer>`
            }
            )}
                  </questions&answers>
                  
                  <bulkAvailableDates>
                    ${JSON.stringify(bulkDates)}
                  </bulkAvailableDates>
                  <maxAppointments in same time slot>
                    ${maxAppointments}
                  </maxAppointments in same time slot>
                  <appointmentDuration in minutes>
                    ${appointmentDuration}
                  </appointmentDuration in minutes>
                  <freeText>
                   ${freeText}
                  </freeText>
                  </knowledgebase>
                  <<Only Available Dates are the dates that are available for actual events booking. Do not suggest any other dates.>>
                  <availableDates>
                  ${format_availableDates}
                  </availableDates>
                  <<Appointment Slots will change based on business settings so they will be dynamic on each request>>
                  <appointmentSlots>
                  ${JSON.stringify(schedule)}
                  </appointmentSlots>
                  <businessId>
                  ${businessId}
                  </businessId>
                  `;
            try {
                const { oauth2Client: googleAuth, access_token: outlook_accessToken, provider: connectedProvider } = await getAuthenticatedOAuth2Client(businessId);
                oauth2Client = googleAuth;
                access_token = outlook_accessToken;
                provider = connectedProvider
            } catch (error) {
                console.log("Error getting authenticated oauth2 client", error);
                return;
            }
      

            // 4. Process each lead sequentially
            for (const leadDoc of leads.docs) {
                const lead = {
                    ...leadDoc.data(),
                    id: leadDoc.id,
                };

                try {
                    // 5. Process each lead's follow-up
                    await processSingleFollowUp({
                        leadData: lead,
                        business,
                        oauth2Client,
                        access_token,
                        provider,
                        knowledgebase_data,
                        docs
                    });
                } catch (error) {
                    console.error(`Error processing lead ${lead.id}:`, error);
                    // Continue with next lead
                }
               
            }
        } catch (error) {
            console.error(`Error processing business ${business.id}:`, error);
            // Continue with next business
        }
    }
};

const processSingleFollowUp = async ({
    leadData,
    business,
    oauth2Client,
    access_token,
    provider,
    knowledgebase_data,
    docs
}) => {

    const { businessId, businessEmail, auth, aiSettings } = business;

    const { followUpTemplates, signature } = aiSettings;

    const {
        email,
        clientName,
        followUpSent: leadFollowUpSent,
        eventType,
        status
    } = leadData;

    const followUpSent = leadFollowUpSent ? leadFollowUpSent :
        eventType.toLowerCase() === "wedding" ? "wedding_follow_up_1" : "non_wedding_follow_up_1";

    //if lead status is Appointment Set or Venue Toured then we will not send any follow up emails
    if (status === "Appointment Set" || status === "Venue Toured") {
        console.log("Lead status is either Appointment Set or Venue Toured", email);
        return;
    }

    let followUpTemplate = null;
    let nextFollowUp = null;

    //if followUpSent is either equal to wedding_follow_up_4 or non_wedding_follow_up_4, we will not send any follow up emails
    if (
        followUpSent === "wedding_follow_up_7" ||
        followUpSent === "non_wedding_follow_up_7"
    ) {
        console.log("No more follow up emails to send to", email);
        return;
    }

    // we will send follow up emails based on the lastFollowup key
    for (const template of followUpTemplates) {
        if (template.key === followUpSent) {
            followUpTemplate = template;
            nextFollowUp =
                followUpTemplates[followUpTemplates.indexOf(template) + 1];
            break;
        } else {
            followUpTemplate = followUpTemplates[0];
            nextFollowUp = followUpTemplates[1];
        }
    }

    if (!followUpTemplate) {
        console.log("No follow up template found for", email);
        return;
    }

    const {
        schedule,
        content,
        deliveryMethod = "email",
        enabled = false,
    } = followUpTemplate;

    let emailBody = content;



    const conversation = await conversationsRef
        .where("sentBy", "==", businessEmail)
        .where("sentTo", "==", email)
        .get();

    if (conversation.empty) {
        console.log(
            "No conversation found between business",
            businessEmail,
            "and lead",
            email
        );
    }

    const conversationData = conversation.docs[0]?.data();
    const lastReceivedEmailTimestamp = conversationData?.lastReceivedAt;
    const lastSentEmailTimestamp = conversationData?.lastSentAt;

    if (!lastReceivedEmailTimestamp) {
        console.log("No last received email timestamp found for", email);
        return;
    }

    //now based on the schedule we will check if we need to send a follow up email
    //schedule is in days i.e 1, 3, 7, 14
    const currentTime = Date.now();
    const lastEmailTime =
        //if it's first followup then use lastReceivedEmailTimestamp else use lastSentEmailTimestamp
        followUpSent === "wedding_follow_up_1" || followUpSent === "non_wedding_follow_up_1"
            ? lastReceivedEmailTimestamp.toDate().getTime()
            : lastSentEmailTimestamp.toDate().getTime();
    const daysDifference = differenceInDays(currentTime, lastEmailTime);
    const scheduledDays = parseInt(schedule);

    console.log(
        "Days difference",
        daysDifference,
        "Scheduled days",
        scheduledDays
    );

    if (daysDifference < scheduledDays) {
        console.log("Not enough time has passed to send a follow up email");
        return;
    }
    //content only has <p></p> tags
    if (!content || content.replace(/<[^>]+>/g, "").trim() === "") {
        // get previous emails from the sub-collection emails

        //all documents that have sentTo as email and sentBy as businessEmail
        const sentEmails = await adminSDK.firestore().collectionGroup("emails")
            .where("sentTo", "==", email)
            .where("sentBy", "==", businessEmail)
            .orderBy("updatedAt", "desc")
            .get();

        const sentEmailsData = sentEmails.docs.map((doc) => doc.data());

        const receivedEmails = await adminSDK.firestore().collectionGroup("emails")
            .where("sentTo", "==", businessEmail)
            .where("sentBy", "==", email)
            .orderBy("updatedAt", "desc")
            .get();
        const receivedEmailsData = receivedEmails.docs.map((doc) => doc.data());
        emailBody = await generateEmail(
            clientName,
            [...sentEmailsData, ...receivedEmailsData],
            'follow-up',
            knowledgebase_data,
            '',
            docs,
            business.name,
            false, // no need to book an appointment
            `We have total 7 follow ups to, This is the ${nextFollowUp.key} follow up`,
            []
        );
        if (!emailBody) {
            console.log("No email body found for", email);
            return;
        }

    }


    if (deliveryMethod == "email" && enabled) {

        const _name = clientName?.split(" ")[0] || clientName;
        //clientName will always have first letter capitalized
        const firstName = _name.charAt(0).toUpperCase() + _name.slice(1);

        //if no content is found, we will not send any follow up emails

        if (provider === "google") {
            let isOngoingThread = true;

            const { threadId, messageID, subjectLine } =
                await getThreadMessageId(oauth2Client, email);
            if (!threadId || !messageID) {
                console.log("Could not get threadId or messageID for", email);
                // return;
                isOngoingThread = false;
            }
            //send email using google
            await sendGoogleEmail({
                oauth2Client,
                to: email,
                subject: isOngoingThread ? subjectLine : "Event Follow Up",
                mode: isOngoingThread ? "reply" : "send",
                threadId: isOngoingThread ? threadId : "",
                inReplyTo: isOngoingThread ? messageID : "",
                // content: emailBody,
                content: `\n<div style="font-family: Arial, sans-serif; color: #000000;font-size: 13px;line-height: 1.6; font-weight: 400;">
                <p>Hi ${firstName},</p>
                  <p>${emailBody} </p>
                  <p>${signature ? signature : ""}</p>
                  <p>PS – If you'd like to see our venue in person, you can schedule a tour by
                <a href="https://app.venuexai.com/book-appointment/${businessId}">clicking here</a> at your convenience. </p>
                </div>\n`,
                customLabel: "Follow Up",
            });
        } else if (provider === "outlook") {

            const { messageID, subjectLine } = await getOutlookThreadMessageId(access_token, email);
            //send email using outlook
            await sendOutlookEmail({
                accessToken: access_token,
                to: email,
                subject: subjectLine || "Event Follow Up",
                content: `\n<div style="font-family: Arial, sans-serif; color: #000000;font-size: 13px;line-height: 1.6; font-weight: 400;">
                <p>Hi ${firstName},</p>
                  <p> ${emailBody}</p> 
                  <p>${signature ? signature : ""}</p>
                  <p>PS – If you'd like to see our venue in person, you can schedule a tour by
                <a href="https://app.venuexai.com/book-appointment/${businessId}">clicking here</a> at your convenience. </p>
                </div>\n`,
                customLabel: "Follow Up",
                messageId: messageID,
                mode: messageID ? "reply" : "send",
            });
        }

        handleEmailSent({
            business: businessEmail,
            email: email,
            emailBody: content,
            clientName: clientName,
        });
    } else if (deliveryMethod == "text" && enabled) {
        try {
            //send text message using twilio
            const { phone } = leadData;

            const fromNumber = convertTwilioNumber(phone)
            const businessTwilioNumber = business.twilioNumber;
            if (!phone) {
                console.log("The lead does not have a phone number", email);
                return;
            }

            const message = await twilioClient.messages.create({
                body: formatForSms(emailBody),
                to: fromNumber,
                from: businessTwilioNumber,
            });

            console.log("Twilio message sent:", message.sid);

            // Update the text-conversations subcollection for the lead
            const conversationRef = adminSDK
                .firestore()
                .collection("businesses")
                .doc(businessId)
                .collection("text-conversations")
                .doc(fromNumber);

            const conversationDoc = await conversationRef.get();
            const id = Math.random().toString(36).substring(2, 15);
            if (!conversationDoc.exists) {
                // Create a new conversation document with clientName
                await conversationRef.set({
                    clientName,
                    messages: [
                        {
                            body: formatForSms(emailBody),
                            sender: "system",
                            timestamp: new Date().toISOString(),
                            id: id,
                        },
                    ],
                    isDeleted: false,
                });
            } else {
                // Add the message to the existing conversation
                await conversationRef.update({
                    messages: adminSDK.firestore.FieldValue.arrayUnion({
                        body: formatForSms(emailBody),
                        sender: "system",
                        timestamp: new Date().toISOString(),
                    }),
                    isDeleted: false,
                });
            }
        } catch (error) {
            console.error("Error sending follow up SMS:", error);
            return;
        }
    } else {
        console.log("No delivery method found for", email);
        return;
    }
    //based on followup sent we will change status to 'First Follow Up' or 'Second Follow Up' or 'Third Follow Up'

    const followUpStatus = getFollowUpStatus(followUpSent);

    // we will update the last follow up key
    await leadsRef.doc(leadData.id).update({
        followUpSent: nextFollowUp.key,
        type: "upcoming",
        status: followUpStatus,
        scheduledFor: new Date(
            currentTime + parseInt(nextFollowUp.schedule) * 24 * 60 * 60 * 1000
        ),
    });
};