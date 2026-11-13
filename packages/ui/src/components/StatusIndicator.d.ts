interface StatusIndicatorProps {
    status: 'connected' | 'disconnected' | 'connecting' | 'error';
    label: string;
}
export declare function StatusIndicator({ status, label }: StatusIndicatorProps): import("react").JSX.Element;
export {};
