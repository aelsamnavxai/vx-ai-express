export const handleErrorLogging = (error, context) => {
    if (error instanceof Error) {
        console.error(`Error in ${context}:`, error.message);
    } else {
        console.error(`Error in ${context}:`, error);
    }
}