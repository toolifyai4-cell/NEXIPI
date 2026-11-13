import type { Message } from '../types';
interface ChatAreaProps {
    messages: Message[];
    isLoading: boolean;
    messagesEndRef: React.RefObject<HTMLDivElement>;
}
export declare function ChatArea({ messages, isLoading, messagesEndRef }: ChatAreaProps): React.JSX.Element;
import React from 'react';
export {};
