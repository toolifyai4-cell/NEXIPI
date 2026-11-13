interface ComposerProps {
    value: string;
    onChange: (value: string) => void;
    onSend: () => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
    disabled: boolean;
    placeholder: string;
}
export declare function Composer({ value, onChange, onSend, onKeyDown, disabled, placeholder }: ComposerProps): import("react").JSX.Element;
export {};
