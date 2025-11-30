import OpenAI from 'openai';
import { Logger } from 'winston';

export class OpenAIService {
  private openai: OpenAI;
  private logger: Logger;
  private systemPrompt: string;

  constructor(logger: Logger, systemPrompt?: string) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is required');
    }
    this.openai = new OpenAI({ apiKey });
    this.logger = logger;
    this.systemPrompt = systemPrompt || `You are a friendly and helpful HR representative who is onboarding new employees. 
Your role is to:
- Welcome new employees warmly
- Answer questions about the company, policies, and procedures
- Guide them through the onboarding process
- Be conversational, approachable, and professional
- Keep responses brief (1-2 sentences) and natural
- Act like a helpful chat bot that engages in conversation

Always respond in a conversational, friendly manner. If someone greets you, greet them back warmly. If they ask questions, answer helpfully. Engage naturally in the conversation.`;
  }

  /**
   * Generate a response using OpenAI based on user input
   * @param userMessage - The message from the user (transcribed speech)
   * @returns AI-generated response text
   */
  async generateResponse(userMessage: string): Promise<string> {
    try {
      this.logger.info('Generating OpenAI response', { userMessage });

      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: this.systemPrompt,
          },
          {
            role: 'user',
            content: userMessage,
          },
        ],
        temperature: 0.7,
        max_tokens: 150,
      });

      const responseText = completion.choices[0]?.message?.content?.trim() || '';

      this.logger.info('Successfully generated OpenAI response', { 
        userMessage, 
        response: responseText,
      });
      
      return responseText || "I'm here to help with your onboarding. How can I assist you today?";
    } catch (error: any) {
      this.logger.error('Error generating OpenAI response', { 
        error: error?.message, 
        errorStack: error?.stack,
        userMessage 
      });
      // Fallback response if AI fails
      return "I'm here to help with your onboarding. How can I assist you today?";
    }
  }

  /**
   * Update the system prompt
   * @param newPrompt - New system prompt to use
   */
  setSystemPrompt(newPrompt: string): void {
    this.systemPrompt = newPrompt;
    this.logger.info('Updated OpenAI system prompt', { newPrompt });
  }

  /**
   * Evaluate a candidate's interview responses
   * @param jobDescription - The job description
   * @param interviewText - The candidate's interview responses
   * @returns Evaluation result with reasoning and decision
   */
  async evaluateCandidate(jobDescription: string, interviewText: string): Promise<{
    reasoning: string;
    decision: 'suitable' | 'not_suitable';
    response: string;
  }> {
    try {
      this.logger.info('Evaluating candidate responses');

      const evaluationPrompt = `Job Description:

{job_description}

Candidate Responses:

{interview_text}

Evaluate the candidate's responses based on the following criteria:

- Depth and clarity of understanding of ML/AI concepts
- Use of tangible, relevant examples
- Demonstrated experience with OpenAI technologies and modern ML methods
- Ability to solve complex problems as described in the role
- Alignment between their experience and the job requirements

Your output should follow this EXACT format:

REASONING:
[Provide a brief analysis (2-3 sentences) explaining:
- Key strengths observed
- Any gaps or concerns
- Overall assessment]

DECISION:
[Either "suitable" or "not_suitable"]

RESPONSE:
[If the candidate is NOT suitable, respond EXACTLY with:
"Thank you for your responses. However, based on the answers provided, it appears there may be a misalignment with the requirements of the role we're seeking to fill. At this time, we cannot extend an offer. We appreciate your time and effort and wish you the best in your future endeavors."

If the candidate IS suitable, respond EXACTLY with:
"Thank you for your thoughtful responses. Based on your answers, it appears that your skills, experience, and understanding align well with the requirements of the role. We will be in touch with the next steps."]`.replace('{job_description}', jobDescription).replace('{interview_text}', interviewText);

      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: evaluationPrompt,
          },
        ],
        temperature: 0.3, // Lower temperature for more consistent evaluation
        max_tokens: 500,
      });

      const responseText = completion.choices[0]?.message?.content?.trim() || '';
      
      // Parse the response to extract reasoning, decision, and response
      const reasoningMatch = responseText.match(/REASONING:\s*(.*?)(?=DECISION:|$)/s);
      const decisionMatch = responseText.match(/DECISION:\s*(suitable|not_suitable)/i);
      const responseMatch = responseText.match(/RESPONSE:\s*(.*?)$/s);

      const reasoning = reasoningMatch?.[1]?.trim() || 'No reasoning provided';
      const decision = (decisionMatch?.[1]?.toLowerCase() === 'suitable' ? 'suitable' : 'not_suitable') as 'suitable' | 'not_suitable';
      const response = responseMatch?.[1]?.trim() || '';

      this.logger.info('Successfully evaluated candidate', { 
        decision,
        reasoningLength: reasoning.length,
      });

      return {
        reasoning,
        decision,
        response: response || (decision === 'suitable' 
          ? 'Thank you for your thoughtful responses. Based on your answers, it appears that your skills, experience, and understanding align well with the requirements of the role. We will be in touch with the next steps.'
          : 'Thank you for your responses. However, based on the answers provided, it appears there may be a misalignment with the requirements of the role we\'re seeking to fill. At this time, we cannot extend an offer. We appreciate your time and effort and wish you the best in your future endeavors.'),
      };
    } catch (error: any) {
      this.logger.error('Error evaluating candidate', { 
        error: error?.message,
        errorStack: error?.stack,
      });
      throw error;
    }
  }
}


