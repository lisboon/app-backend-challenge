import { z } from 'zod';

export const uuid = z.uuid().transform((value) => value.toLowerCase());
