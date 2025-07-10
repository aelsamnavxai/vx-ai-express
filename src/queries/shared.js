
import { db,adminSDK } from "../config/firebase";
import { Timestamp } from "firebase-admin/firestore";
import { handleErrorLogging } from "../utils";


export async function getKnowledgeBaseData(businessId){
    const knowledgeBaseRef = db.collection("knowledgebase").doc(businessId);
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



export async function handleEmailSent(body) {
    const { business, email, clientName, emailBody } = body;
    let isUnique = true;

    if (!email) {
       return {
            status: 400,
            message: "Email is required",
        };
    }

    const conversationsRef = db.collection("conversations");

    try {
        const emailsSentQuery = await conversationsRef
            .where("sentTo", "==", email) // lead-email
            .where("sentBy", "==", business) // business-email
            .get();

        if (!emailsSentQuery.empty) {
            isUnique = false;
            emailsSentQuery.forEach(async (doc) => {
                const docId = doc.id;
                const docData = doc.data();
                await conversationsRef.doc(docId).update({
                    count: docData.count + 1,
                    updatedAt: adminSDK.firestore.FieldValue.serverTimestamp(),
                    lastSentAt: adminSDK.firestore.FieldValue.serverTimestamp(),
                });

                const emailsQuery = await conversationsRef
                    .doc(docId)
                    .collection("emails")
                    .where("sentTo", "==", business)
                    .orderBy("createdAt", "desc")
                    .limit(1)
                    .get();

                let clientEmailData;
                if (!emailsQuery.empty) {
                    clientEmailData = emailsQuery.docs[0].data();
                    for (const doc of emailsQuery.docs) {
                        await conversationsRef
                            .doc(docId)
                            .collection("emails")
                            .doc(doc.id)
                            .update({
                                hasReplied: true,
                                repliedAt: adminSDK.firestore.FieldValue.serverTimestamp(),
                            });
                    }
                }

                await conversationsRef
                    .doc(docId)
                    .collection("emails")
                    .add({
                        sentTo: email,
                        sentBy: business,
                        clientName,
                        updatedAt: adminSDK.firestore.FieldValue.serverTimestamp(),
                        createdAt: adminSDK.firestore.FieldValue.serverTimestamp(),
                        hasReplied: false,
                        repliedAt: null,
                        averageResponseTime: clientEmailData
                            ? Math.floor(
                                adminSDK.firestore.Timestamp.now().seconds -
                                clientEmailData.createdAt.seconds
                            )
                            : 0,
                        emailBody: emailBody || "",
                    });
            });
        } else {
            const docRef = await conversationsRef.add({
                sentTo: email,
                sentBy: business,
                count: 1,
                clientName,
                updatedAt: adminSDK.firestore.FieldValue.serverTimestamp(),
                createdAt: adminSDK.firestore.FieldValue.serverTimestamp(),
                lastReceivedAt: null,
                lastSentAt: adminSDK.firestore.FieldValue.serverTimestamp(),
                averageResponseTime: 0,
                firstResponseAt: null,
                isEnded: false,
                hasReplied: false,
            });

            await docRef.collection("emails").add({
                sentTo: email,
                sentBy: business,
                clientName,
                updatedAt: adminSDK.firestore.FieldValue.serverTimestamp(),
                createdAt: adminSDK.firestore.FieldValue.serverTimestamp(),
                hasReplied: false,
                repliedAt: null,
                emailBody: emailBody || "",
            });
        }

        const metricsRef = db.collection("metrics").doc(business);
        const metricsDoc = await metricsRef.get();

        if (metricsDoc.exists) {
            await metricsRef.update({
                totalEmailsSent: adminSDK.firestore.FieldValue.increment(1),
                uniqueEmails: isUnique
                    ? adminSDK.firestore.FieldValue.increment(1)
                    : adminSDK.firestore.FieldValue.increment(0),
                updatedAt: adminSDK.firestore.FieldValue.serverTimestamp(),
                totalFirstEmailsSent: isUnique
                    ? adminSDK.firestore.FieldValue.increment(1)
                    : adminSDK.firestore.FieldValue.increment(0),
                onGoingConversations: isUnique
                    ? adminSDK.firestore.FieldValue.increment(1)
                    : adminSDK.firestore.FieldValue.increment(0),
            });
        } else {
            await metricsRef.set({
                totalEmailsSent: 1,
                uniqueEmails: 1,
                leadsHandledByAI: 0,
                toursBooked: 0,
                leadReplies: 0,
                updatedAt: adminSDK.firestore.FieldValue.serverTimestamp(),
                createdAt: adminSDK.firestore.FieldValue.serverTimestamp(),
                totalFirstEmailsSent: 0,
                endedConversations: 0,
                onGoingConversations: 1,
            });
        }

        return 
    } catch (error) {
        handleErrorLogging(error, "handleEmailSent");
        return {
            status: 500,
            message: `Error writing to Firestore: ${error.message || error}`,
        };
    }
}
  