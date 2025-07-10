import { adminSDK } from "../config/firebase";
import OpenAI from 'openai';
import Anthropic from "@anthropic-ai/sdk";
import { followUpPrompt } from "../queries/prompts";

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY, // Ensure this is set in your environment variables
});


const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

export const generateEmail = async (
    senderName: string,
    pastEmails: any,
    emailBody: string,
    knowledgeBase: any,
    initialReply: string,
    docs: any,
    businessName: string,
    bookTour: boolean,
    additionalInstructions: string,
    customAnswersbyBusiness: any[] = []
): Promise<string> => {
    try {
        //fetch prompt from firebase 'prompts' collection and 'sales-agent' document
        const docRef = adminSDK
            .firestore()
            .collection("prompts")
            .doc("sales-agent");
        const doc = await docRef.get();
        if (!doc.exists) {
            console.error("No such document!");
            return "";
        }
        const data = doc.data();
        if (!data) {
            console.error("No data found in document!");
            return "";
        }

        const emailReplyPrompt = data.prompt || "";
        const isFirstMessage = pastEmails.length <= 1 ? true : false;

        const isFollowUp = emailBody == "follow-up";
        const prompt =
            // if not a followup then user emailReplyPrompt and replace all <<BusinessName>> with businessName
            isFollowUp
                ? followUpPrompt
                : emailReplyPrompt.replace(/<<BusinessName>>/g, businessName);
        try {
            console.log("Using anthropic");
            const msg = await anthropic.messages.create({
                // model: "claude-3-5-sonnet-20241022",
                model: "claude-sonnet-4-20250514",
                max_tokens: 380,
                system:
                    prompt +
                    `Only answer from the provided knowledgebase data, you do not have access to any other data or information.`,
                messages: [
                    {
                        role: "user",
                        content: isFollowUp
                            ? "This is a followup message for" +
                            senderName +
                            ", based on conversation history or the last message that was sent by us or client You need to generate a followup message and strictly follow the provide instructions. Please do not add any greetings or Client Name in the email body." +
                            senderName
                            : `This is an ongoing conversation, with ${senderName} Here is the last message recevied: ${JSON.stringify(emailBody)}. Now generate a reply based on instructions and do not add greetings like Hi, Hello or any other greeting in the response. 
                 ${isFirstMessage && "This is the first email that we are sending to client so you will follow the template that is in  <wedding-initial-reply> or <non-wedding-initial-reply> tags based on the event type. Always use this template irrelevant of the email recevied from the lead. First thing will be this template and then your response based on user email. Since it is a template do not add or modify anthing in the template. Do not event include clientName in the template and do not add Greetings Like Thank You because that part would be in the template"}
                 Do not add any response or text after PS or Regards or any other closing text. as the email will be closed after that.
                 Do not hallucinate the email content and strictly follow the instructions provided.
                 Avoid suggesting days that are not enabled in schedule for appointment booking.
                 Add proper formatting to the email and make sure that the email is formatted correctly in the email client.
                 For the first email we will only ask one pre-qualifying question.
                 Never use "PS", "P.S.", or any postscript notation at the end of your messages. All information, including booking links, tour opportunities, or additional offerings, must be integrated naturally into the main body of your response.
                 Do not book or confirm appointments on the calendar unless the lead explicitly confirms the exact date and time they would like to schedule. Always ask for confirmation before proceeding
                 The knowledge base is provided for your reference and you can use it to generate the email body.
                 Here is the knowledge base breakdown for better understanding:
                <knowledgebase> -> opening and closing of the knowledge base
                <questions&answers> -> contains the questions and answers in the knowledge base related to business
                <availableDates> -> [[These are the dates that we have available for events booking, DO NOT SUGGEST ANY OTHER DATES as we do not have them available]]
                <freeText> -> contains the free text in the knowledge base related to business like:  if a lead asks about how many people they can bring to a tour, the limit is 4.
                </knowledgebase> -- this is the end of the knowledge base breakdown
  
                Custom Answers Breakdown for better understanding:
                <customAnswers> -> opening and closing of the custom answers
                <userMessage> -> contains the user message that maybe similar to what lead is asking. Like budget discount, family members, etc.
                <response> -> contains the response that business has provided for the user message, You need to send this response without any modifications.
                </customAnswers> -- this is the end of the custom answers breakdown
                 `,
                    },
                    {
                        role: "assistant",
                        content: `I understand the instructions, I will not suggest to hold a date and only provide dates from <availableDates> for events. I have received the email and I will generate a tailored email body of max 110 words based on the instructions provided and add proper <p> </p> tags in my message for proper formatting. 
              ${bookTour && "As the user has booked a tour I will Always end appointment booking confirmations with a clear, definitive statement and NEVER end with a question"}
              ${isFirstMessage && "Also This is the first email that we are sending to client so you will follow the template that is in  <wedding-initial-reply> or <non-wedding-initial-reply> tags based on the event type. Always use this template irrelevant of the email recevied from the lead. First thing will be this template and then your response based on user email. Since it is a template do not add or modify anthing in the template. Do not event include clientName in the template and do not add Greetings Like Thank You because that part would be in the template"}
              Also I will Never use "PS", "P.S.", or any postscript notation at the end of your messages. All information, including booking links, tour opportunities, or additional offerings, 
              will be integrated naturally into the main body of my response.' + isFirstMessage && 'As this is the first email that we are sending to client so you will follow the template that is in  
              <wedding-initial-reply> or <non-wedding-initial-reply> tags based on the event type. Always use this template irrelevant of the email recevied from the lead. First thing will be this template and then your response based on user email. 
              Since it is a template do not add or modify anthing in the template. Do not event include clientName in the template and do not add Greetings Like Thank You because that part would be in the template and 
              I will also outline the value provided and include ONLY ONE pre-qualifying question and I will not suggest any day that is not enabled in schedule for appointment and tours.
              and I will go through the custom answers provided by the business and if the user email matches with any of the custom answers then I will use that reply instead of generating a new reply
              for better clarity here are some examples of some specific cases : 
              <Holding Date>
              If a lead asks to hold a date then you would respond similar to this:
              <p> We’re unable to hold dates until you come in for a tour. Let’s get you scheduled! When is the best time for you to visit? </p>
              </Holding Date>
  
              `,
                    },
                    {
                        role: "user",
                        content: `
              Perfect, now that you have understood the instructions, Now composed a seasoned email body with maximum of 110 words, based on the instructions, add <p> tags for each line of the email and make sure that the email is formatted correctly in the email client.
              we will be sending the email through html so we need tags for line breaks and formatting. I have also provided you all the  knowledge base and documents data for your reference and also provided custom answers. The event dates are in <availableDates> tag, no other date is available for events
              Here are the additional details that you need to create the email:
                <formattingType> 
                ${isFollowUp ? "Follow Up Email formatting" : "Normal Email formatting with <p> tags for each line of the email"}
                </formattingType>
                <firstReplyTemplates>
                For Wedding and Non Wedding Event Types ${initialReply}
                </firstReplyTemplates>
                ${knowledgeBase}
                <documents> 
                ${JSON.stringify(docs)} 
                <documents>
                <isFirstMessage> 
                This is ${isFirstMessage ? "the first email" : "not the first email"} to be sent by the agent
                </isFirstMessage>
                <todayDate>
                ${new Date().toISOString()}
                </todayDate>
                <pastEmails> ${JSON.stringify(pastEmails)} </pastEmails>
                <currentTime>
                ${new Date().toISOString()}
                </currentTime>
                <examples>
                <p> {{ First Line of the email }} </p>
                <p> {{ Second Line of the email }} </p>
                and so on
                </examples>
                << Do not add any text after you have closed the email >>
                << Do not provide text like I have responded or generated email as per instructions >>
                << Provide slots in the format specified in the instructions , like if a business has schedule of 9:00 AM to 5:00 PM and slot duration is 30 minutes. then this is the format : Monday: 10:00 AM, 10:30 AM, 11:00 AM through 5:30 PM. So we do not need to write every slot, because we need to keep the email in a professional format and more readable.>>
                Here is the last message recevied: <emailData> ${JSON.stringify(emailBody)} </emailData>
                  Here are the custom answers provided by the business. If user email body is similar to any of the userMessage then use the response provided by the business in response.
                Remeber : Override/Ignore examples provided in the system prompt if the user email body is similar to any of the userMessage in the custom answers.
                <customAnswers>
                ${JSON.stringify(customAnswersbyBusiness)}
                </customAnswers>
  
                Go through the conversation, understand the dates which lead has mentioned, the guest counts, the budget and every other key point mentioned by the lead.
                
                Also I have mentioned this in earlier but I am repeating it again, the event dates and tour dates are super important. 
                If the date is within 1.5 months (45 days) of the current date then it cannot be an event date, it would be a tour date. 
                I have provided you the ongoing conversation with the lead for better understanding of the context.
                If a lead asks for a tour date or an appointment then do not mix those up with the event date that they initially asked for, 
                Usually the first email would contain the event date, and it may change mid conversation depending on the availablity of the dates.
  
                A lead may get frustrated if you mix up the dates and provide wrong dates for tours or appointments. You have the conversation history
                , take your time to go through the messages and understand what to reply to the lead.
  
                In the conversation history a lead may be discussing only about the event dates and mention they are interested in specific days of the week only, like They may say saturday would be fine. 
                Now before replying, go over the conversation its clearly mentioned that they are talking about events on Saturdays, do not mix it up with appointment/tour dates. 
                we will suggest the appointment dates based on the business schedule and availability of the dates.
                so if business has monday tuesday and wednesday available for tours then we will suggest those days. 
  
                Similarly a lead may go through the appointment days/slots and say they are available on specific day like Friday. Now in this case we will go through the business schedule and see if Friday is available for tours or appointments, if it is then we will suggest that day.
                and provide slots based on availability and settings
                
                It is all about understanding the context of the conversation and replying accordingly.
                The email history will be provided in a descending order, so the latest email will be at the top and the oldest email will be at the bottom.
  
                Your response must:
                ✓ Reference specific details they've shared (use their exact dates/numbers)
                ✓ Build on previous discussion points (don't repeat info already covered)
                ✓ Address their current question while acknowledging their stated needs
                ✓ Move the conversation forward appropriately for the current stage
  
                These are the additional instructions for you to follow:
                ${additionalInstructions}
             
             `,
                    },
                ],
            });
            let response = msg.content[0] as any;

            let generatedEmail = response.text;
            // let email = generatedEmail.replace(/<p>\s*(PS|P\.S\.).*?<\/p>/i, "").replace(/<p>\s*(P.S|P\.S\.).*?<\/p>/i, "")
            let email = generatedEmail
                .replace(/(?:^|\n)\s*(P\.?S\.?)\s*[–—:.]?.*?(?:\.|$)/i, "")
                .trim();
            //we will check if the output has a PS and if it does we will remove it till the last </p> tag
            //PS or P.S. or any postscript notation
            console.log("Generated email:", response.text);

            // add a </br> tag after each </p> tag
            // email = provider == 'outlook' && !leadEmail.includes('gmail') ? email.replace(/<\/p>/g, "</p><br>") : email

            //if the email is missing closing </p> tag then we will add it
            if (!email.endsWith("</p>")) {
                email = email + "</p>";
            }
            //if there are <scheduling_process> and </scheduling_process> tags in the email then we will remove them along with the content inside them
            email = email.replace(
                /<scheduling_process>[\s\S]*?<\/scheduling_process>/g,
                ""
            );
            return email;
        } catch (error) {
            try {
                console.error("Error generating email with anthropic:", error);
                const res = await openai.chat.completions.create({
                    model: "gpt-4o-2024-08-06",
                    max_completion_tokens: 350,
                    messages: [
                        {
                            role: "user",
                            content: isFollowUp
                                ? "This is a followup message for" +
                                senderName +
                                ", based on conversation history or the last message that was sent by us or client You need to generate a followup message and strictly follow the provide instructions and this is the client name that you need to use to address : " +
                                senderName
                                : `This is an ongoing conversation, with ${senderName} Here is the last message recevied: ${JSON.stringify(emailBody)}. Now generate a reply based on instructions and do not add greetings like Hi, Hello or any other greeting in the response. 
                   ${isFirstMessage && "This is the first email that we are sending to client so you will follow the template that is in  <wedding-initial-reply> or <non-wedding-initial-reply> tags based on the event type. Always use this template irrelevant of the email recevied from the lead. First thing will be this template and then your response based on user email. Since it is a template do not add or modify anthing in the template. Do not event include clientName in the template and do not add Greetings Like Thank You because that part would be in the template"}
                   Do not add any response or text after PS or Regards or any other closing text. as the email will be closed after that.
                   Do not hallucinate the email content and strictly follow the instructions provided.
                   Avoid suggesting days that are not enabled in schedule for appointment booking.
                   Add proper formatting to the email and make sure that the email is formatted correctly in the email client.
                   For the first email we will only ask one pre-qualifying question.
                   Never use "PS", "P.S.", or any postscript notation at the end of your messages. All information, including booking links, tour opportunities, or additional offerings, must be integrated naturally into the main body of your response.
                   Do not book or confirm appointments on the calendar unless the lead explicitly confirms the exact date and time they would like to schedule. Always ask for confirmation before proceeding
                   The knowledge base is provided for your reference and you can use it to generate the email body.
                   Here is the knowledge base breakdown for better understanding:
                  <knowledgebase> -> opening and closing of the knowledge base
                  <questions&answers> -> contains the questions and answers in the knowledge base related to business
                  <availableDates> -> [[These are the dates that we have available for events booking, DO NOT SUGGEST ANY OTHER DATES as we do not have them available]]
                  <freeText> -> contains the free text in the knowledge base related to business like:  if a lead asks about how many people they can bring to a tour, the limit is 4.
                  </knowledgebase> -- this is the end of the knowledge base breakdown
                   `,
                        },
                        {
                            role: "assistant",
                            content: `I understand the instructions, I will not suggest to hold a date and only provide dates from <availableDates> for events. I have received the email and I will generate a tailored email body of max 110 words based on the instructions provided and add proper <p> </p> tags in my message for proper formatting. 
                ${bookTour && "As the user has booked a tour I will Always end appointment booking confirmations with a clear, definitive statement and NEVER end with a question"}
                ${isFirstMessage && "Also This is the first email that we are sending to client so you will follow the template that is in  <wedding-initial-reply> or <non-wedding-initial-reply> tags based on the event type. Always use this template irrelevant of the email recevied from the lead. First thing will be this template and then your response based on user email. Since it is a template do not add or modify anthing in the template. Do not event include clientName in the template and do not add Greetings Like Thank You because that part would be in the template"}
                Also I will Never use "PS", "P.S.", or any postscript notation at the end of your messages. All information, including booking links, tour opportunities, or additional offerings, 
                will be integrated naturally into the main body of my response.' + isFirstMessage && 'As this is the first email that we are sending to client so you will follow the template that is in  
                <wedding-initial-reply> or <non-wedding-initial-reply> tags based on the event type. Always use this template irrelevant of the email recevied from the lead. First thing will be this template and then your response based on user email. 
                Since it is a template do not add or modify anthing in the template. Do not event include clientName in the template and do not add Greetings Like Thank You because that part would be in the template and 
                I will also outline the value provided and include ONLY ONE pre-qualifying question and I will not suggest any day that is not enabled in schedule for appointment and tours.
                for better clarity here are some examples of some specific cases : 
                <Holding Date>
                If a lead asks to hold a date then you would respond similar to this:
                <p> We’re unable to hold dates until you come in for a tour. Let’s get you scheduled! When is the best time for you to visit? </p>
                </Holding Date>
                `,
                        },
                        {
                            role: "user",
                            content: `
                Perfect, now that you have understood the instructions, Now composed a seasoned email body with maximum of 110 words, based on the instructions, add <p> tags for each line of the email and make sure that the email is formatted correctly in the email client.
                we will be sending the email through html so we need tags for line breaks and formatting. I have also provided you all the knowledge base and documents data for your reference. The event dates are in <availableDates> tag, no other date is available for events
                Here are the additional details that you need to create the email:
                  <formattingType> 
                  ${isFollowUp ? "Follow Up Email formatting" : "Normal Email formatting with <p> tags for each line of the email"}
                  </formattingType>
                  <firstReplyTemplates>
                  For Wedding and Non Wedding Event Types ${initialReply}
                  </firstReplyTemplates>
                  ${knowledgeBase}
                  <documents> 
                  ${JSON.stringify(docs)} 
                  <documents>
                  <isFirstMessage> 
                  This is ${isFirstMessage ? "the first email" : "not the first email"} to be sent by the agent
                  </isFirstMessage>
                  <todayDate>
                  ${new Date().toISOString()}
                  </todayDate>
                  <pastEmails> ${JSON.stringify(pastEmails)} </pastEmails>
                  <currentTime>
                  ${new Date().toISOString()}
                  </currentTime>
                  <examples>
                  <p> {{ First Line of the email }} </p>
                  <p> {{ Second Line of the email }} </p>
                  and so on
                  </examples>
                  << Do not add any text after you have closed the email >>
                  << Do not provide text like I have responded or generated email as per instructions >>
                  Here is the last message recevied: <emailData> ${JSON.stringify(emailBody)} </emailData>
                  These are the additional instructions for you to follow:
                  ${additionalInstructions}
               `,
                        },
                    ],
                });

                const fallbackMessage = res.choices?.[0]?.message?.content ?? "";

                console.log("res.choices?.[0]:", res.choices?.[0]);
                console.log("OpenAI fallback response:", fallbackMessage);

                if (!fallbackMessage.trim()) {
                    throw new Error("Fallback model returned empty content.");
                }

                let sanitizedEmail = fallbackMessage
                    .replace(/(?:^|\n)\s*(P\.?S\.?)\s*[–—:.]?.*?(?:\.|$)/i, "")
                    .trim();
                if (!sanitizedEmail.endsWith("</p>")) {
                    sanitizedEmail = sanitizedEmail + "</p>";
                }
                return sanitizedEmail;
            } catch (fallbackErr) {
                console.error(
                    "Error generating email with fallback OpenAI model:",
                    fallbackErr
                );
                return "";
            }
        }
    } catch (error) {
        console.error("Error generating email:", error);
        return "";
    }
};
  