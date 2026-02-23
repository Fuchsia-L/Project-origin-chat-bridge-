export type PersonaMessageRole = "user" | "assistant";

export interface PersonaExampleMessage {
    role: PersonaMessageRole;
    content: string;
}

export interface Persona {
    id: string;
    user_id: string;
    name: string;
    avatar_url?: string;
    system_prompt: string;
    greeting?: string;
    example_messages?: PersonaExampleMessage[];
    description?: string;
    tags?: string[];
    is_default?: boolean;
    created_at: string;
    updated_at: string;
}

export interface PersonaCreate {
    name: string;
    system_prompt: string;
    avatar_url?: string;
    greeting?: string;
    example_messages?: PersonaExampleMessage[];
    description?: string;
    tags?: string[];
    is_default?: boolean;
}
