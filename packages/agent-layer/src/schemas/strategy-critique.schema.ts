import { z } from 'zod';

export const strategyCritiqueSchema = z.object({
  verdict: z.enum(['approve', 'revise', 'reject']),
  summary: z.string(),
  issues: z.array(
    z.object({
      code: z.string(),
      severity: z.enum(['low', 'medium', 'high', 'critical']),
      message: z.string(),
    }),
  ),
  recommendations: z.array(z.string()),
});

export type StrategyCritique = z.infer<typeof strategyCritiqueSchema>;