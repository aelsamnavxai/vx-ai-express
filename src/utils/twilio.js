
import twilio from 'twilio';
export const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

/**
 * Formats a phone number to a valid Twilio SMS format.
 * Removes all non-numeric characters and ensures the number starts with a country code.
 * 
 * @param phoneNumber - The raw phone number input (e.g., "+1 (208) 581-0614").
 * @returns The formatted phone number (e.g., "12085810614").
 * @throws Error if the phone number is invalid or cannot be formatted.
 */
export function formatPhoneNumber(phoneNumber) {
    // Remove all non-numeric characters
    const numericOnly = phoneNumber.replace(/\D/g, '');

    // Ensure the number starts with a valid country code (e.g., 1 for the US)
    if (!numericOnly.startsWith('1')) {
        throw new Error('Phone number must start with a valid country code (e.g., 1 for the US).');
    }

    // Ensure the number has the correct length (11 digits for US numbers)
    if (numericOnly.length !== 11) {
        throw new Error('Phone number must be 11 digits long (including country code).');
    }

    return numericOnly;
}

//convert twilio number
//remove all special characters, including the - + ( ) and add 1 in front of the number
//if the number is not 10 digits then add 1 in front of the number
// 18482194885 is correct
//8482194885 would be 18482194885
export const convertTwilioNumber = (number) => {
    // Remove all non-numeric characters
    const numericOnly = number.replace(/[^0-9]/g, "");

    // Check if the number is already in the correct format
    if (numericOnly.length === 11 && numericOnly.startsWith('1')) {
        return numericOnly;
    }

    if (numericOnly.length === 10) {
        // If the number is 10 digits long, add '1' at the beginning
        return `1${numericOnly}`;
    }

    // If the number is not in the correct format return the numeric only
    return numericOnly;
};
