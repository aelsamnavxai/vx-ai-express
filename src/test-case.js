import { adminSDK } from "./config/firebase.js";
import axios from 'axios';
import { format } from "date-fns";
import { DateTime } from "luxon";
import { appointmentBookingPrompt } from "./prompts.js";

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

export const getBusinessDetails = async (businessId) => {
  try {
    const businessRef = adminSDK.firestore().collection("businesses").doc(businessId);
    const businessDoc = await businessRef.get();
    if (!businessDoc.exists) {
      console.error(`❌ Business with ID ${businessId} does not exist.`);
      return null;
    }
    const businessData = businessDoc.data();
    return {
      id: businessDoc.id,
      ...businessData,
    }
  } catch (error) {
    console.error(`❌ Failed to get business details for ${businessId}:`, error.message);
    return null;
  }
}

function isWithinBusinessHours(rawTime, businessEndTime) {
  console.log("rawTime", rawTime, "businessEndTime", businessEndTime);
  // Parse the rawTime (ISO format)
  const appointmentTime = new Date(rawTime);
  const appointmentHours = appointmentTime.getHours();
  const appointmentMinutes = appointmentTime.getMinutes();

  // Parse business end time (e.g., "7:00pm")
  const [businessTime, period] = businessEndTime.toLowerCase().split(/(am|pm)/);
  let [businessHours, businessMinutes] = businessTime.split(':').map(Number);

  // Convert to 24-hour format
  if (period === 'pm' && businessHours !== 12) {
    businessHours += 12;
  } else if (period === 'am' && businessHours === 12) {
    businessHours = 0;
  }

  // Compare hours and minutes
  if (appointmentHours > businessHours) {
    return false;
  } else if (appointmentHours === businessHours) {
    return appointmentMinutes <= businessMinutes;
  }

  return true;
}





const listActiveSubscriptions = async (data) => {
  const { auth } = data;
  console.log(data);
  if (!auth?.access_token) return [];
  let accessToken = auth.access_token;

  try {
    const expiryBuffer = 6 * 60 * 1000; // 6 minutes buffer before token expiry
    const now = Date.now();
    if (expiryBuffer >= auth.expiry_date) {
      const data = await refreshOutlookAccessToken(auth.refresh_token);
      if (!data) return;
      accessToken = data.access_token;

    }
    const response = await axios.get('https://graph.microsoft.com/v1.0/subscriptions', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    return response.data.value || [];
  } catch (err) {
    console.log(`❌ Failed to list subscriptions for business ${data.businessId}:`, err.response?.data || err.message);
    return [];
  }
}



async function getKnowledgeBaseData(businessId) {
  const knowledgeBaseRef = adminSDK.firestore().collection("knowledgebase").doc(businessId);
  const [docSnapshot, qnaSnapshot, availabilitySnapshot, metadataSnapshot] = await Promise.all([
    knowledgeBaseRef.collection("documents").get(),
    knowledgeBaseRef.collection("qna").get(),
    knowledgeBaseRef.collection("availability").get(),
    knowledgeBaseRef.collection("metadata").doc("metadata").get(),
  ]);

  const documents = docSnapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
    uploadDate: (doc.data().uploadDate).toDate().toISOString(),
  }))

  const qna = qnaSnapshot.docs.map((doc) => ({
    question: doc.data().question,
    answer: doc.data().answer,
    createdAt: (doc.data().createdAt).toDate().toISOString(),
    updatedAt: doc.data().updatedAt
      ? (doc.data().updatedAt).toDate().toISOString()
      : undefined,
    tags: doc.data().tags || [],
  }))

  const questions = qna.map((item) => item.question);
  const answers = qna.map((item) => item.answer);

  const availableDates = availabilitySnapshot.docs.map((doc) => ({
    date: (doc.data().date).toDate(),
    blocks: doc.data().blocks || [],
  }))

  const metadata = metadataSnapshot.exists
    ? {
      websiteUrl: metadataSnapshot?.data()?.websiteUrl || "",
      freeText: metadataSnapshot?.data()?.freeText || "",
      bulkDates: metadataSnapshot?.data()?.bulkDates || "",
      lastUpdated: (metadataSnapshot?.data()?.lastUpdated).toDate().toISOString(),
    }
    : { websiteUrl: "", freeText: "", bulkDates: "", lastUpdated: new Date().toISOString() };

  return {
    documents,
    questions,
    answers,
    availableDates,
    bulkDates: metadata.bulkDates,
    websiteUrl: metadata.websiteUrl,
    freeText: metadata.freeText,
  };
}


const checkDatesAvailablity = async (pastEmails = [], emailBody = "Hi, do you have any availability on 14th or 15th of March?", format_availableDates = []) => {


  try {
    const currentDate = new Date().toISOString();
    // Prepare the data for the API request
    // const formattedDate = format(date, "EEEE, MMMM do, yyyy"); format is ufr
    const data = JSON.stringify({
      "messages": [
        {
          "role": "system",
          "content": `    You are an event booking assistant. You will be provided with an email body, the conversation history and a list of available dates for the events.
            Your task is to understand the email,You only have access to and are responsible for event dates, Any date or inquiry asked by the lead will be answered as per the event dates provided in the availableDates.
            The historical conversation is very important to understand, a lead may have just asked about the event date in the the initial email and then in the conversation they are just asking about the
            tours or appointments so you need to understand the context of the email and the conversation history.
            A general rule of thumb is that if the mentioned date is within 1.5 months from the current date, it is likely related to an appointment booking, not an event date.
            This conversation history is provided in [pastEmails] tag.
            A lead may ask for specific date, a range of dates, or a month. Some leads may ask for dates next year or any other year.
            Before you compare the dates, convert it to weekday for better comparison.
            Use this function JS function to add week day : new Date('requestedDate').toLocaleDateString('en-US', { weekday: 'long', month: 'long' })
            You will be provided a list of dates in DD/MM/YYYY Format and your task is to check if the requested date is available in the list of available dates.

            * Do not suggest dates that are not in the <availableDates> list.
            * Make sure you are not missing any dates in the <availableDates> list.
            * The output should not contain duplicate dates.
            * Do not suggest any dates on your own or from your knowledge.
            * Do not hallucinate any dates.
            * Strictly follow the dates provided in the <availableDates> list.
             
            
            The available dates will be an array of strings in understandable format and some might have blocks in them.
            Carefully check the dates provided and compare the day,month and year of the requested date with the available dates
            If the requested date is not available then return the dates from availableDates that are near that date.
            Do not provide dates that are in the past. A lead may mistakenly provide a date that is in the past, so you need to check if the date is in the past or not.
            If none is available then just return an empty array.
            Appointments are typically booked within 1.5 months from the current date, so handle that in the reason. that the date is related to appointment booking and not events.
            If a lead mentions different dates in the email as an example they can mention both appointment and event dates, then you need to check the dates for events only and ignore the appointment dates.
            Do not provide any reason or comments on the tours or appointments because they are different from the events and you are only responsible for events. The tours and appointments related info is provided in <TourandAppointments> tag.
            For your reference today is ${currentDate}
            Do not provide dates that are in the past.
            The output should be in JSON format with the following keys

            isAvailable: boolean, [true if the requested date is available in the availableDates list, false otherwise]
            availableDatesknowledegebase: array of strings, [the dates that are available in the availableDates list and are closest to the requested date]
            reason: string, [the reason for the availability or unavailability of the requested date]
            requestedDate: string, [the requested date in YYYY-MM-DD format]
            
            The email body could have dates in any of the following formats:
            1. mm/dd/yyyy
            2. yyyy-mm-dd (/ or -) 
            The month will be before the day.
            If lead ask for multiple dates then in reason return mention availablity of each date an isAvailable will be true if there are dates in the range that lead has requested.

            ** Slots BreakDown **
            Some businesses have event days divided in different slots like Evening, Afternoon, Morning, etc. 
            1. Evening slot depicts that the day is availble for evening events only. 'Monday, April 20th, 2026 - Evening (18:30 - 23:45)',
            2. Afternoon slot depicts that the day is availble for afternoon events only. 'Sunday, April 19th, 2026 - Afternoon (11:30 - 17:00)',
            3. Morning slot depicts that the day is availble for morning events only.  'Monday, April 20th, 2026 - Morning (08:00 - 11:30)',
            4. If no slot is mentioned then it means the day is available for all day events. 'Saturday, December 27th, 2025 - Afternoon (11:30 - 17:00), Evening (18:30 - 23:45)',
            5. If there are multiple slots mentioned in front of the date then that day is available for those mentioned slots only.

            If a lead doesn't specify any time slot then you need to assume that the lead is flexiable with any event slot and we will consider that day for availableDates suggestions

    `
        },
        {
          "role": "user",
          "content": "Now that you have understood the instructions, I will provide you how to process and reason the dates and email body. Carefully analzye the dates in the <availableDates> list and the email body provided in <emailBody> tag, we have access to only these dates."
        },
        {
          "role": "assistant",
          "content": `Here is an example of reasoning and how you should process the dates and email body.
reasoning_content: "First, I am an event booking assistant, and I only handle event dates. I must not comment on tours or appointments.
'I need to check if this requested date is available in the provided <availableDates> list. For instance if the requested date is 10/24/2026. I should convert this to YYYY-MM-DD format for comparison. 10/24/2026 in EEEE MM/DD/YYYY is October 24, 2026, so YYYY-MM-DD is 2026-10-24.
'Now, I need to check if this date is in the availableDates list. The availableDates are provided in a format like "Friday, October 24th, 2025", but I see dates for 2025 and 2026. I need to look for "October 24th, 2026".
'Scanning the availableDates list:
I see "Sunday, October 25th, 2026" – that's the 25th.'- "Monday, October 26th, 2026" – 26th.
'- "Tuesday, October 27th, 2026" – 27th.
'- And so on.
'Specifically, for October 2026, I have:
'- "Thursday, October 1st, 2026 Afternoon (11:30 - 17:00)'" [that means this date is available for afternoon events only]
'- "Friday, October 2nd, 2026" [available all day]
'- "Saturday, October 3rd, 2026"
'- "Sunday, October 4th, 2026"
'- "Tuesday, October 6th, 2026" – missing 5th?
'- "Wednesday, October 7th, 2026"
'- "Thursday, October 8th, 2026"
'- "Friday, October 9th, 2026"
'- "Sunday, October 11th, 2026" – missing 10th?
'- "Wednesday, October 14th, 2026" – missing 13th?
'- "Thursday, October 15th, 2026"
'- "Friday, October 16th, 2026"
'- "Saturday, October 17th, 2026"
'- "Sunday, October 18th, 2026"
'- "Tuesday, October 20th, 2026" – missing 19th?
'- "Wednesday, October 21st, 2026"
'- "Thursday, October 22nd, 2026"
- "Sunday, October 25th, 2026" – here's 25th, but what about 24th?

I don't see "October 24th, 2026" in the list. Let me check again.

Looking carefully: after "Thursday, October 22nd, 2026", it jumps to "Sunday, October 25th, 2026". So, October 24th is missing. Is it listed? No, I don't see it.

'No entry for 24th. So, October 24, 2026 is not in the availableDates list.
'Now, the requested date is 2026-10-24. I need to find dates near this date from availableDates that are not in the past. Since the current date is ${currentDate}, all dates in 2026 are in the future, so no issue with past dates.
'I need to find the closest available dates. Looking at October 2026 available dates:
'- "Thursday, October 1st, 2026"
'- "Friday, October 2nd, 2026"
'- "Saturday, October 3rd, 2026"
'- "Sunday, October 4th, 2026"
'- "Tuesday, October 6th, 2026" – missing 5th?
'- "Wednesday, October 7th, 2026"
'- "Thursday, October 8th, 2026"
'- "Friday, October 9th, 2026"
'- "Sunday, October 11th, 2026" – missing 10th?
'- "Wednesday, October 14th, 2026" – missing 13th?
'- "Thursday, October 15th, 2026"
'- "Friday, October 16th, 2026"
'- "Saturday, October 17th, 2026"
'- "Sunday, October 18th, 2026"
'- "Tuesday, October 20th, 2026" – missing 19th?
'- "Wednesday, October 21st, 2026"
'- "Thursday, October 22nd, 2026"


'I should include dates within a small range. The instruction says: "return the dates from availableDates that are near that date." It doesn't specify how many, but probably the closest ones. Since it's an array, I can include october dates.
'Looking at the list: October 21, 22, 25, etc.

"To be precise, I'll calculate the difference.
'Requested date: 2026-10-24

'Available dates around:
'- 2026-10-22: Thursday
'- 2026-10-25: Sunday
'Also, 2026-10-21: Wednesday, which is 3 days before, while Oct 22 is 2 days before, Oct 25 is 1 day after.

'So the closest are Oct 22 and Oct 25.
'But Oct 25 is only 1 day after, Oct 22 is 2 days before. I should include both.
'Perhaps include dates within, say, 3 days or so.
"But to keep it simple, I'll include the immediate neighbors.
"If the lead asks for other dates in October 2026 then I should include all october dates from the availableDates list.
'So those would be '- "Thursday, October 1st, 2026"
'- "Friday, October 2nd, 2026"
'- "Saturday, October 3rd, 2026"
'- "Sunday, October 4th, 2026"
'- "Tuesday, October 6th, 2026" – missing 5th?
'- "Wednesday, October 7th, 2026"
'- "Thursday, October 8th, 2026"
'- "Friday, October 9th, 2026"
'- "Sunday, October 11th, 2026" – missing 10th?
'- "Wednesday, October 14th, 2026" – missing 13th?
'- "Thursday, October 15th, 2026"
'- "Friday, October 16th, 2026"
'- "Saturday, October 17th, 2026"
'- "Sunday, October 18th, 2026"
'- "Tuesday, October 20th, 2026" – missing 19th?
'- "Wednesday, October 21st, 2026"
'- "Thursday, October 22nd, 2026"

'In the availableDates, for October 2026, I have:
'- Oct 20: Tuesday
'- Oct 21: Wednesday
'- Oct 22: Thursday
'- Then skip to Oct 25: Sunday
'- Oct 26: Monday
'- Etc.
'So the dates near Oct 24 are Oct 22 and Oct 25.
'Before returning available dates, I need to ensure they are formatted correctly. in YYYY-MM-DD format.
'The availableDates are in a readable format like "Thursday, October 22nd, 2026". I need to convert these to YYYY-MM-DD format for the output.
'I should return these in the availableDatesknowledegebase array after converting all of these to YYYY-MM-DD format.
'Now, for the JSON output:
"- isAvailable: false, since it's not in the list.
'- availableDatesknowledegebase: an array of strings from the availableDates that are near. The strings should be as provided in the availableDates list. So for Oct 22, it's "Thursday, October 22nd, 2026", and for Oct 25, it's "Sunday, October 25th, 2026".
'- reason: I need to provide a reason. The reason should be that the requested date is not available, but nearby dates are suggested.
'- requestedDate: in YYYY-MM-DD format, which is 2026-10-24.
'Also, I need to convert the dates into weekday and month name using the function, but the requestedDate is already in the format, and I'm outputting it as string in YYYY-MM-DD. The instruction says: "convert it to weekday and month name for better comparison" but that was for internal use, so For the output, requestedDate is just the date in YYYY-MM-DD and the availableDatesknowledegebase is an array of strings in YYYY-MM-DD format.
'Re-reading: "Before you compare the dates, After you have converted the requested date to YYYY-MM-DD format, convert it to weekday and month name for better comparison." But for the output, it's "requestedDate: string, [the requested date in YYYY-MM-DD format]", so I don't need to include weekday in the output, just for comparison.
'In the output JSON, requestedDate is YYYY-MM-DD.
'Now, for availableDatesknowledegebase, it should be an array of the date strings from availableDates, so I'll use the exact strings like "Thursday, October 22nd, 2026" etc.
'Now, is there any date exactly on Oct 24? No, I confirmed.
'Also, ensure no past dates: current date is 2025-07-23, so 2026-10-24 is future, fine.
'Reason: "The requested date 2026-10-24 is not available in our event dates. However, we have nearby dates available."
'But be specific. "The requested event date for October 24, 2026, is not available. Closest available dates are October 22, 2026, and October 25, 2026."
'But I should not mention appointments, as per instruction.
"Also, the date is far in the future, not within 1.5 months, so it's clearly an event date.
'Now, for the array, I'll include "Wednesday, October 21st, 2026", "Thursday, October 22nd, 2026", and "Sunday, October 25th, 2026". But Oct 21 is a bit farther. To keep it close, perhaps just the immediate ones: Oct 22 and Oct 25.
'Difference: Oct 24 - Oct 22 = 2 days, Oct 25 - Oct 24 = 1 day. So both are within 2 days.
"I could include Oct 21 as well, but it's 3 days before, while others are closer.
"But the instruction doesn't specify how many, so I'll include Oct 22 and Oct 25"

Another Scnerio:
If the lead asks for date range like "what dates are available in September 2026" then you need to check the availableDates for that month and return the dates that are available in that month.
<emailBody> What dates are available in September 2026? </emailBody>
reasoning_content: "The lead is asking for dates in September 2026, so I need to check the availableDates for that month and return the dates that are available in that month.
The availableDates are provided in a format like "Friday, September 1st, 2026", so I need to check for dates in September 2026.
I will check the availableDates list for dates in September 2026 and return the dates that are available in that month.
The availableDates are:
['Friday, September 1st, 2026', 'Saturday, September 2nd, 2026', 'Sunday, September 3rd, 2026', 'Monday, September 4th, 2026', 'Tuesday, September 5th, 2026', 'Wednesday, September 6th, 2026', 'Thursday, September 7th, 2026', 'Friday, September 8th, 2026', 'Saturday, September 9th, 2026', 'Sunday, September 10th, 2026', 'Monday, September 11th, 2026', 'Tuesday, September 12th, 2026', 'Wednesday, September 13th, 2026', 'Thursday, September 14th, 2026', 'Friday, September 15th, 2026', 'Saturday, September 16th, 2026', 'Sunday, September 17th, 2026', 'Monday, September 18th, 2026', 'Tuesday, September 19th, 2026', 'Wednesday, September 20th, 2026', 'Thursday, September 21st, 2026', 'Friday, September 22nd, 2026', 'Saturday, September 23rd, 2026', 'Sunday, September 24th, 2026'].
I will check for dates in September 2026 and return the dates that are available in that month.
The available dates in September 2026 are:
['Friday, September 1st, 2026', 'Saturday, September 2nd, 2026', 'Sunday, September 3rd, 2026', 'Monday, September 4th, 2026', 'Tuesday, September 5th, 2026', 'Wednesday, September 6th, 2026', 'Thursday, September 7th, 2026', 'Friday, September 8th, 2026', 'Saturday, September 9th, 2026', 'Sunday, September 10th, 2026', 'Monday, September 11th, 2026', 'Tuesday, September 12th, 2026', 'Wednesday, September 13th, 2026', 'Thursday, September 14th, 2026', 'Friday, September 15th, 2026', 'Saturday, September 16th, 2026', 'Sunday, September 17th, 2026', 'Monday, September 18th, 2026', 'Tuesday, September 19th, 2026', 'Wednesday, September 20th, 2026', 'Thursday, September 21st, 2026', 'Friday, September 22nd, 2026', 'Saturday, September 23rd, 2026', 'Sunday, September 24th, 2026'].
I will return these dates in the availableDatesknowledegebase array.
As the lead has not mentioned any specific date, I will return all the dates in September 2026.
I will convert the isAvailable to true as the lead has asked for dates in September 2026 and we have available dates in that month.
I will re-read the dates in the list and ensure that I am not missing any dates.
The available dates in September 2026 are:
['Friday, September 1st, 2026', 'Saturday, September 2nd, 2026', 'Sunday, September 3rd, 2026', 'Monday, September 4th, 2026', 'Tuesday, September 5th, 2026', 'Wednesday, September 6th, 2026', 'Thursday, September 7th, 2026', 'Friday, September 8th, 2026', 'Saturday, September 9th, 2026', 'Sunday, September 10th, 2026', 'Monday, September 11th, 2026', 'Tuesday, September 12th, 2026', 'Wednesday, September 13th, 2026', 'Thursday, September 14th, 2026', 'Friday, September 15th, 2026', 'Saturday, September 16th, 2026', 'Sunday, September 17th, 2026', 'Monday, September 18th, 2026', 'Tuesday, September 19th, 2026', 'Wednesday, September 20th, 2026', 'Thursday, September 21st, 2026', 'Friday, September 22nd, 2026', 'Saturday, September 23rd, 2026', 'Sunday, September 24th, 2026'].
I will return these dates in the availableDatesknowledegebase array.

** This scenario and dates were only for your understanding, the email and actual dates will be provided in the <emailBody> and <availableDates> tags **.
`

        },
        {
          "role": "user",
          "content": `
             <pastEmails> ${JSON.stringify(pastEmails)} <pastEmails>
             <currentDate> ${currentDate} <currentDate>
             <StartOfemail> ${JSON.stringify(emailBody)} <EndOfemail>
             <availableDates> ${JSON.stringify(format_availableDates)} <availableDates>
          `
        }
      ],
      "model": "deepseek-chat",
      "frequency_penalty": 0,
      "max_tokens": 2048,
      "presence_penalty": 0,
      "response_format": {
        "type": "json_object"
      },
      "stop": null,
      "stream": false,
      "stream_options": null,
      "temperature": 1,
      "top_p": 1,
      "tools": null,
      "tool_choice": "none",
      "logprobs": false,
      "top_logprobs": null
    });

    let config = {
      method: 'post',
      maxBodyLength: Infinity,
      url: 'https://api.deepseek.com/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': 'Bearer sk-16f8c0dd70dc435ea9e9678031eb62f9'
      },
      data: data
    };

    const response = await axios.request(config);
    if (response.status !== 200) {
      throw new Error(`DeepSeek API error: ${response.statusText}`);
    }
    const data_ = response.data;
    // const data_ = response.data;
    const result = data_.choices[0].message.content;
    // console.log('reasoning content', data_.choices[0].message.reasoning_content);
    return JSON.parse(result);
    // console.log('response data', data_.choices[0].message);

  } catch (error) {
    console.error("Error getting booking month:", error);
    return {
      isAvailable: false,
      availableDatesknowledegebase: [],
      reason: "Error processing date availability",
      requestedDate: ""
    };
  }
};


const fetchBlockedOpenDates = async (
  businessId,
) => {
  const baseRef = adminSDK
    .firestore()
    .collection("businesses")
    .doc(businessId);

  const doc = await baseRef.get();
  if (!doc.exists) {
    return {
      blockedDates: [],
      openDates: [],
    };
  }

  const businessData = doc.data();
  const timeZone = businessData?.timeZone || "America/New_York";

  const [blockedDatesSnap, openDatesSnap] = await Promise.all([
    baseRef.collection("blocked-dates").get(),
    baseRef.collection("open-dates").get(),
  ]);

  const parseDateWithTimezone = (utcISOString) => {
    // Convert UTC timestamp -> business's local Date (with time set to midnight)
    return DateTime.fromISO(utcISOString, { zone: "utc" })
      .setZone(timeZone)
      .startOf("day")
      .toJSDate();
  };

  const blockedDates = blockedDatesSnap.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      ...data,
      date: parseDateWithTimezone(data.timeStamp || data.date),
    };
  })

  const openDates = openDatesSnap.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      ...data,
      date: parseDateWithTimezone(data.timeStamp || data.date),
    };
  })

  return { blockedDates, openDates };
};


//
const checkForBooking = async ({
  emailData,
  schedule,
  appointmentDuration,
  bookedAppointments,
  timeZone,
  maxAppointments,
  pastEmails,
  blockedDates
}) => {
  try {
    const prompt = `
    ${appointmentBookingPrompt}
    Here is the ongoing conversation with the lead for better understanding of the context:
    <onGoingConversation>
    ${JSON.stringify(pastEmails)}
    </onGoingConversation>
    <emailData>
    ${JSON.stringify(emailData)}
    </emailData>
    <businessSchedule>
    ${JSON.stringify(schedule)}
    </businessSchedule>

    <appointmentDuration>
    ${appointmentDuration}
    </appointmentDuration>

    <bookedAppointments>
    ${JSON.stringify(bookedAppointments)}
    </bookedAppointments>

    <timeZone>
    ${timeZone}
    </timeZone>

    <currentTime>
    ${new Date().toISOString()}
    </currentTime>

    <blockedDates>
    ${JSON.stringify(blockedDates)}
    </blockedDates>

    [These are the maximum number of appointments that can be booked in a single timeslot at a time even if we already have some booked appointments]
    <maxAppointments> 
    ${maxAppointments}
    </maxAppointments>

    Here is an example of maxAppointments for better understanding:
    <maxAppointments>
    2
    </maxAppointments>
    <bookedAppointments>
    booked appointments [
  {
    id: '7iuvm57t9d4qo0u2ds7bn0q46o',
    selectedDate: '2025-05-02',
    title: 'Personal Calendar 2nnd May',
    selectedTime: '2025-05-02T08:55:00.000',
    endTime: '2025-05-02T09:25:00.000',
    provider: 'google'
  },
  {
    id: '7c4gj457rhuavtq1mgavgv6sd8',
    selectedDate: '2025-05-16',
    title: 'Appointment with Regency Garden',
    selectedTime: '2025-05-16T09:00:00.000',
    endTime: '2025-05-16T10:00:00.000',
    provider: 'google'
  },
  {
    id: 'lhb9tdvdkmqe1odo4qvr20bf4k',
    selectedDate: '2025-05-16',
    title: 'Appointment with Regency Garden',
    selectedTime: '2025-05-16T10:00:00.000',
    endTime: '2025-05-16T11:00:00.000',
    provider: 'google'
  },
  {
    id: '35oin2cn25n1u4u9liebdnab3g',
    selectedDate: '2025-05-16',
    title: 'Appointment with Regency Garden',
    selectedTime: '2025-05-16T14:00:00.000',
    endTime: '2025-05-16T15:00:00.000',
    provider: 'google'
  },
  {
    id: 'jl8es1rbikvoioticejfp3n204',
    selectedDate: '2025-05-23',
    title: 'Appointment with Regency Garden',
    selectedTime: '2025-05-23T14:00:00.000',
    endTime: '2025-05-23T15:00:00.000',
    provider: 'google'
  }
]
  </bookedAppointments>

  The lead has asked for Friday, May 2nd, 2025, at 9:00 AM, which is already booked based on selectedTime and endTime, so now in this case we will allow the lead to
  book appointment on same slot because we have maxAppointments set to 2 and we already have 1 appointment booked in the same slot.
  
  output: {
  bookTour: true,
  rawTime: '2025-05-16T14:00:00.000',
  reason: 'The requested slot is available for booking as we still have 1 appointment available in the same slot',
   }

   Example if the requested date is in the past:
    <emailData>
    I am looking for 14th March 2025
    </emailData>
   
    output: {
      bookTour: false,
      rawTime: '2023-03-14',
      reason: 'The requested date is in the past and not available for booking'
    }


  Each business will have different appointment duration under their settings so you need to suggest timeslots duration as per their settings, the duration will be provided in <appointmentDuration in minutes> tags
    <Calculation of the appointment time with business schedule and slots allocation Examples>
  <example 1>
    <appointmentDuration>
      30
    </appointmentDuration>	

    Now slots will be of 30 minutes each, so if they have opening hours from 10 am then slots will be 10:00 AM, 10:30 AM, 11:00 AM.
    If a lead asks for a 10:15 AM then it will not be available because as per the appointment duration it will be 30 minutes slot and the next available slot will be 10:30 AM.
    
    <emailData>
    I am looking for an appointment on Friday, May 16th, 2025, at 10:15 AM.
    </emailData>
    output: {
      bookTour: false,
      rawTime: '2025-05-16T10:15:00.000',
      reason: 'The requested time slot is not available as we book on the half hour, so while 10:15 AM isn’t available, we do have 10:00 AM, 10:30 AM, and 11:00 AM open on that day. Would one of those work for you?'
    }
    </example 1>

    <example 2>
    <appointmentDuration>
      60
    </appointmentDuration>	
    Now slots will be of 60 minutes each, so if they have opening hours at 10 am then slots will be 10:00 AM, 11:00 AM, 12:00 PM. For example, DO NOT suggest a 10:30 AM slot or book an appointment if the start time is 10:00 AM and business has slot duration of 60 minutes.
    If a lead asks for a 10:30 AM then it will not be available because as per the appointment duration it will be 60 minutes slot and the next available slot will be 11:00 AM.
    <emailData>
    I am looking for an appointment on Friday, May 16th, 2025, at 10:30 AM.
    </emailData>
    output: {
      bookTour: false,
      rawTime: '2025-05-16T10:30:00.000',
      reason: 'The requested time slot is not available as we book on the hour, so while 10:30 AM isn’t available, we do have 10:00 AM, 11:00 AM, and 12:00 PM open on that day. Would one of those work for you?'
    }
    </example2> 

  <example 3>
  <appointmentDuration>
    30
  </appointmentDuration>
  Now slots will be of 30 minutes each, so if they have opening hours at 10 am then slots will be 10:00 AM, 10:30 AM, 11:00 AM. For example, DO NOT suggest a 10:15 AM slot or book an appointment if the start time is 10:00 AM and business has slot duration of 30 minutes.
  if a lead asks for 11:00 AM then it will be available because as per the appointment duration it will be 30 minutes slot and the next available slot will be 11:30 AM.
  <emailData>
  I am looking for an appointment on Friday, May 16th, 2025, at 11:00 AM.
  </emailData>
  output: {
    bookTour: true,
    rawTime: '2025-05-16T11:00:00.000',
    reason: 'The requested time slot is available for booking as we book on the half hour, so 11:00 AM is available and the next available slot will be 11:30 AM.'
  }
  </example 3>
  </Calculation of the appointment time with business schedule and slots allocation Examples>

  <example 4>
  <appointmentDuration>
    30
  </appointmentDuration>
  <maxAppointments>
    2
  </maxAppointments>
  If a lead asks for a timeSlot that has already reached maxAppointments then that timeSlot will not be available for booking.
  We will look for other available timeSlots for that day if they are available and there is room for booking in those timeSlots.
  If those slots have also reached maxAppointments then suggest different day or time.
  <emailData>
  I am looking for an appointment on Friday, May 16th, 2026, at 10:00 AM.
  </emailData>
  <bookedAppointments>
  [
    {
      "id": "7iuvm57t9d4qo0u2ds7bn0q46o",
      "selectedDate": "2025-05-16",
      "title": "Personal Calendar 2nnd May",
      "selectedTime": "2025-05-16T10:00:00.000",
      "endTime": "2025-05-16T10:30:00.000",
      "provider": "google"
    },
    {
      "id": "7c4gj457rhuavtq1mgavgv6sd8",
      "selectedDate": "2025-05-16",
      "title": "Appointment with Regency Garden",
      "selectedTime": "2025-05-16T10:00:00.000",
      "endTime": "2025-05-16T10:30:00.000",
      "provider": "google"
    }
  ]
  }
  </bookedAppointments>

  <schedule>
  {
    "Monday": "10:00 AM - 5:00 PM",
    "Tuesday": "10:00 AM - 5:00 PM",
    "Wednesday": "10:00 AM - 5:00 PM",
    "Thursday": "10:00 AM - 5:00 PM",
    "Friday": "10:00 AM - 5:00 PM",
    "Saturday": "10:00 AM - 3:00 PM",
    "Sunday": "Closed"
  }
  </schedule>

  Now as we can see that the lead has requested for 10:00 AM on Friday, May 16th, 2025, but that timeSlot is already booked by 2 appointments and we have maxAppointments set to 2.
  So now as per the business schedule and slots allocation the next available timeSlot will be 10:30 AM on that day.
  Now we will check if we have booked appointments for 10:30 AM on that day, if we have then we will check for next available timeSlot which will be 11:00 AM.
  If that is also booked then we will check for next available timeSlot which will be 11:30 AM. and so on.

  Case 1: [ If other slots are available for the same day ]
  output: {
    bookTour: false,
    rawTime: '2025-05-16T10:00:00.000',
    reason: 'The requested timeslot of 10:00 AM is not available for booking as it has reached the maximum number of appointments allowed. However, we have availability at 10:30 AM, 11:00 AM, and 11:30 AM on that day. Would any of those work for you?'
  }

  Case 2: [ If no other slots are available for the same day ]
  output: {
    bookTour: false,
    rawTime: '2025-05-16T10:00:00.000',
    reason: 'The requested timeslot of 10:00 AM is not available for booking as it has reached the maximum number of appointments allowed. Unfortunately, we do not have any other available time slots on that day. Would you like to choose a different day or time?'
  }

  </example 4>
  End of examples

  Do not suggest dates in the past and never allow booking for past dates.
  The bookTour will be always false for dates that are past current date. and reason would be 'The requested date is in the past and not available for booking'

  <example 5>
  <emailData>
  I am looking for an appointment on Friday, March 14th, 2026
  </emailData>
  <currentTime>
  ${new Date().toISOString()}
  </currentTime>
  output: {
    bookTour: false,
    rawTime: '2026-03-14',
    reason: 'The requested date is in the past and not available for booking. Ask the lead to provide a future date for booking.'
  }
  </example 5>
    `;

    let config = {
      method: 'post',
      maxBodyLength: Infinity,
      url: 'https://api.deepseek.com/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': 'Bearer sk-16f8c0dd70dc435ea9e9678031eb62f9'
      },
      data: JSON.stringify({
        "messages": [
          {
            "role": "system",
            "content": prompt + `The output should be in JSON format with the following keys: clientName, email, phone, notes, startTime, endTime, bookTour, rawTime, dayOfWeek, hasRequestedPhoneCall, contactNumber, reason`
          },
          {
            "role": "user",
            "content": ` <emailData ${emailData} </emailData> <businessSchedule ${JSON.stringify(schedule)} </businessSchedule>`
          }
        ],
        "model": "deepseek-chat",
        "frequency_penalty": 0,
        "max_tokens": 2048,
        "presence_penalty": 0,
        "response_format": {
          "type": "json_object"
        },
        "stop": null,
        "stream": false,
        "stream_options": null,
        "temperature": 1,
        "top_p": 1,
        "tools": null,
        "tool_choice": "none",
        "logprobs": false,
        "top_logprobs": null
      })

    };

    const response = await axios.request(config);
    if (response.status !== 200) {
      throw new Error(`DeepSeek API error: ${response.statusText}`);
    }
    const data_ = response.data;
    const result = data_.choices[0].message.content;

    const booking = JSON.parse(result);

    //rawTime format : 2025-06-02T10:00:00.000

    //check if rawTime is a past date
    if (new Date(booking.rawTime) < new Date()) {
      return {
        clientName: booking.clientName || "",
        email: booking.email || "",
        phone: booking.phone || "",
        notes: "The requested date is in the past and not available for booking",
        startTime: booking.startTime,
        endTime: booking.endTime,
        bookTour: false,
        rawTime: booking.rawTime,
        dayOfWeek: "Sunday",
        hasRequestedPhoneCall: false,
        contactNumber: "",
        reason: "The requested date is in the past and not available for booking",
      };
    }

    //check if its valid
    const isValid = isWithinBusinessHours(booking.rawTime, schedule[booking.dayOfWeek].endTime);

    console.log("isValid", isValid, booking.rawTime, schedule[booking.dayOfWeek].endTime);



    return booking;
  } catch (error) {
    console.error("Error checking for booking:", error);
    return {
      clientName: "",
      email: "",
      phone: "",
      notes: "Error checking for booking",
      startTime: "",
      endTime: "",
      bookTour: false,
      rawTime: "",
      dayOfWeek: "Sunday",
      hasRequestedPhoneCall: false,
      contactNumber: "",
      reason: "",
    };
  }
};


// try {
//   const businessId = '0joktYHnlqGAbLSeqphy'
//   const businessData = await getBusinessDetails(businessId);
//   const pastEmails = []
// //   const emailData = `
// // Please make a booking for Next Tuesday 7:30 pm`

// const emailData =`
// Email received body: body, html {

//         font-family: Roboto, Helvetica, Arial, sans-serif;

//       }



//       body {

//         margin: 0;

//         padding: 0;

//         -webkit-font-smoothing: antialiased;

//         -webkit-text-size-adjust: 100%;

//         -ms-text-size-adjust: 100%;

//       }



//       #outlook a {

//         padding: 0;

//       }



//       .ReadMsgBody {

//         width: 100%;

//       }



//       .ExternalClass {

//         width: 100%;

//       }



//       .ExternalClass * {

//         line-height: 100%;

//       }



//       table,

//       td {

//         mso-table-lspace: 0pt;

//         mso-table-rspace: 0pt;

//       }



//       img {

//         border: 0;

//         height: auto;

//         line-height: 100%;

//         outline: none;

//         text-decoration: none;

//         -ms-interpolation-mode: bicubic;

//       }



//       p {

//         display: block;

//         margin: 13px 0;

//       }

    

    

    

//       @media only screen and (max-width:580px) {

//         @-ms-viewport {

//           width: 320px;

//         }



//         @viewport {

//           width: 320px;

//         }

//       }

    

    

    

          

          

            

//             96

          

          

          

    

          

//             .outlook-group-fix { width:100% !important; }

          

    



    

//   body, html {font-family:Roboto,Helvetica,Arial,sans-serif;}@font-face {

//   font-family: 'Roboto';

//   font-style: normal;

//   font-weight: 400;

//   src: url(//fonts.gstatic.com/s/roboto/v18/KFOmCnqEu92Fr1Mu4mxP.ttf) format('truetype');

// }

// @font-face {

//   font-family: 'Roboto';

//   font-style: normal;

//   font-weight: 500;

//   src: url(//fonts.gstatic.com/s/roboto/v18/KFOlCnqEu92Fr1MmEU9fBBc9.ttf) format('truetype');

// }

// @font-face {

//   font-family: 'Roboto';

//   font-style: normal;

//   font-weight: 700;

//   src: url(//fonts.gstatic.com/s/roboto/v18/KFOlCnqEu92Fr1MmWUlfBBc9.ttf) format('truetype');

// }

// @font-face {

//   font-family: 'Material Icons Extended';

//   font-style: normal;

//   font-weight: 400;

//   src: url(//fonts.gstatic.com/s/materialiconsextended/v152/kJEjBvgX7BgnkSrUwT8UnLVc38YydejYY-oE_LvM.ttf) format('truetype');

// }

// @font-face {

//   font-family: 'Google Material Icons';

//   font-style: normal;

//   font-weight: 400;

//   src: url(//fonts.gstatic.com/s/googlematerialicons/v144/Gw6kwdfw6UnXLJCcmafZyFRXb3BL9rvi0QZG3g.otf) format('opentype');

// }



// .google-material-icons {

//   font-family: 'Google Material Icons';

//   font-weight: normal;

//   font-style: normal;

//   font-size: 24px;

//   line-height: 1;

//   letter-spacing: normal;

//   text-transform: none;

//   display: inline-block;

//   white-space: nowrap;

//   word-wrap: normal;

//   direction: ltr;

// }

// @font-face {

//   font-family: 'Google Material Icons Filled';

//   font-style: normal;

//   font-weight: 400;

//   src: url(//fonts.gstatic.com/s/googlematerialiconsfilled/v118/WWXFlimHYg6HKI3TavMkbKdhBmDvgach8TVpeGsuueSZJH4.otf) format('opentype');

// }



// .google-material-icons-filled {

//   font-family: 'Google Material Icons Filled';

//   font-weight: normal;

//   font-style: normal;

//   font-size: 24px;

//   line-height: 1;

//   letter-spacing: normal;

//   text-transform: none;

//   display: inline-block;

//   white-space: nowrap;

//   word-wrap: normal;

//   direction: ltr;

// }

// @font-face {

//   font-family: 'Google Sans';

//   font-style: normal;

//   font-weight: 400;

//   src: url(//fonts.gstatic.com/s/googlesans/v14/4UaGrENHsxJlGDuGo1OIlL3Owps.ttf) format('truetype');

// }

// @font-face {

//   font-family: 'Google Sans';

//   font-style: normal;

//   font-weight: 500;

//   src: url(//fonts.gstatic.com/s/googlesans/v14/4UabrENHsxJlGDuGo1OIlLU94YtzCwM.ttf) format('truetype');

// }

// @font-face {

//   font-family: 'Google Sans';

//   font-style: normal;

//   font-weight: 700;

//   src: url(//fonts.gstatic.com/s/googlesans/v14/4UabrENHsxJlGDuGo1OIlLV154tzCwM.ttf) format('truetype');

// }



      

//         .body-container {

//           padding-left: 16px;

//           padding-right: 16px;

//         }

      

  

      

//         u+.body .body-container,

//         body[data-outlook-cycle] .body-container,

//         #MessageViewBody .body-container {

//           padding-left: 0;

//           padding-right: 0;

//         }

      

  

    

//       @media only screen and (min-width:580px) {

//         .column-per-37 {

//           width: 37% !important;

//           max-width: 37%;

//         }



//         .column-per-63 {

//           width: 63% !important;

//           max-width: 63%;

//         }

//       }

    

  

    

//       .appointment-buttons th {

//         display: block;

//         clear: both;

//         float: left;

//         margin-top: 12px;

//       }



//       .appointment-buttons th a {

//         float: left;

//       }



//       #MessageViewBody .appointment-buttons th {

//        margin-top: 24px;

//       }

    

  

    

//       @media only screen and (max-width:580px) {

//         table.full-width-mobile {

//           width: 100% !important;

//         }



//         td.full-width-mobile {

//           width: auto !important;

//         }

//       }

    

    

//       .main-container-inner,

//       .info-bar-inner {

//         padding: 12px 16px !important;

//       }



//       .main-column-table-ltr {

//         padding-right: 0 !important;

//       }



//       .main-column-table-rtl {

//         padding-left: 0 !important;

//       }



//       @media only screen and (min-width:580px) {

//         .main-container-inner {

//           padding: 24px 32px !important;

//         }



//         .info-bar-inner {

//           padding: 12px 32px !important;

//         }



//         .main-column-table-ltr {

//           padding-right: 32px !important;

//         }



//         .main-column-table-rtl {

//           padding-left: 32px !important;

//         }



//         .appointment-buttons th {

//           display: table-cell;

//           clear: none;

//         }

//       }



//       .primary-text {

//         color: #3c4043 !important;

//       }



//       .secondary-text,

//       .phone-number a {

//         color: #70757a !important;

//       }



//       .accent-text {

//         color: #1a73e8 !important;

//       }



//       .accent-text-dark {

//         color: #185abc !important;

//       }



//       .grey-button-text,

//       .attachment-chip a {

//         color: #5f6368 !important;

//       }



//       .primary-button {

//         background-color: #1a73e8 !important;

//       }



//       .primary-button-text {

//         color: #fff !important;

//       }



//       .underline-on-hover:hover {

//         text-decoration: underline !important;

//       }



//       .grey-infobar-text {

//         color: #202124 !important;

//       }



//       @media (prefers-color-scheme: dark) {

//         .primary-text:not([class^="x_"]) {

//           color: #e8eaed !important;

//         }



//         .secondary-text:not([class^="x_"]),

//         .phone-number:not([class^="x_"]) a {

//           color: #9aa0a6 !important;

//         }



//         .grey-button-text:not([class^="x_"]),

//         .attachment-chip:not([class^="x_"]) a {

//           color: #bdc1c6 !important;

//         }



//         .accent-text:not([class^="x_"]),

//         .hairline-button-text:not([class^="x_"]) {

//           color: #8ab4f8 !important;

//         }



//         .primary-button:not([class^="x_"]) {

//           background-color: #8ab4f8 !important;

//         }



//         .primary-button-text:not([class^="x_"]) {

//           color: #202124 !important;

//         }

//       }

    

    

//       @media (prefers-color-scheme: dark) {

//         .cse-banner:not([class^="x_"]) {

//           background-color: #3c4043 !important; /* Google Grey 800 */

//         }



//         .encryption-icon:not([class^="x_"]) {

//           /* WARNING: This causes the whole style tag to get stripped in Gmail. */

//           background-image: url('https://fonts.gstatic.com/s/i/googlematerialiconsfilled/encrypted/v3/gm_grey200-24dp/2x/gm_filled_encrypted_gm_grey200_24dp.png') !important;

//         }

//       }

    

    

    

//       .prevent-link a {

//         color: inherit !important;

//         text-decoration: none !important;

//         font-size: inherit !important;

//         font-family: inherit !important;

//         font-weight: inherit !important;

//         line-height: inherit !important;

//       }

    

    



    

      

//         .main-container-inner {

//           padding: 24px 32px !important;

//         }



//         .info-bar-inner {

//           padding: 12px 32px !important;

//         }



//         .cse-banner .encryption-icon {

//           /* We use the IE workaround instead. */

//           background-image: none !important;

//         }



//         .cse-banner .encryption-icon .ms-fallback {

//           display: block !important;

//         }



//         /* NB: Some MS clients ignore dark-scheme styling and apply their own, so there's nothing we can do to help there. */

//         @media (prefers-color-scheme: dark) {

//           .cse-banner:not([class^="x_"]) .encryption-icon .ms-fallback {

//             display: none !important;

//           }



//           .cse-banner:not([class^="x_"]) .encryption-icon .ms-fallback-dark {

//             display: block !important;

//           }

//         }

      

    

//   Appointment with Regency Garden &nbsp; Andrew Mageo has accepted this invitation. &nbsp; WhenTuesday Jul 29, 2025 ⋅ 7:30pm – 8:15pm (Mountain Time - Denver)Organizerinfo@regencygarden.comGuestsAndrew MageoView all guest infoInvitation from Google CalendarYou are receiving this email because you are subscribed to calendar notifications. To stop receiving these emails, go to Calendar settings, select this calendar, and change "Other notifications".Forwarding this invitation could allow any recipient to send a response to the organizer, be added to the guest list, invite others regardless of their own invitation status, or modify your RSVP. Learn more
// `

//   const { schedule, appointmentDuration, bookedAppointments, timeZone, maxAppointments } = businessData;

//   const res = await checkForBooking({
//     emailData,
//     schedule,
//     appointmentDuration,
//     bookedAppointments,
//     timeZone,
//     maxAppointments,
//     pastEmails,
//     blockedDates: []
//   });

//   // console.log("Booking response:", res);

  

//   // console.log("Response from checkDatesAvailablity:", res);


// } catch (error) {
//   console.error("Error in main execution:", error);
// }