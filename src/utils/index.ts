export const handleErrorLogging = (error: any, context: string) => {
    if (error instanceof Error) {
        console.error(`Error in ${context}:`, error.message);
    } else {
        console.error(`Error in ${context}:`, error);
    }
}