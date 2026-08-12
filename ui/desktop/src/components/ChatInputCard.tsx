import React from 'react';
import { cn } from '../utils';

/**
 * Shared visual wrapper for the ChatInput.
 *
 * Both the Hub (empty-chat landing) and the BaseChat (active session)
 * present ChatInput as a focused editorial work surface on the canvas.
 * Centralizing it here keeps the look in sync and gives a single place
 * to tweak the recipe.
 */
export const ChatInputCard: React.FC<{
  className?: string;
  children: React.ReactNode;
}> = ({ className, children }) => (
  <div
    className={cn(
      'overflow-hidden rounded-xl border border-border-primary bg-background-primary shadow-sm',
      'transition-[border-color,box-shadow] duration-200',
      className
    )}
  >
    {children}
  </div>
);
