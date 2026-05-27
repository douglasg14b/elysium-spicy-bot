export type LevelUpMessageInput = {
    userId: string;
    level: number;
    totalXp: number;
};

export function buildLevelUpMessage(input: LevelUpMessageInput): string {
    const mention = `<@${input.userId}>`;
    return `🎉 ${mention} leveled up to **Level ${input.level}**! (${input.totalXp.toLocaleString()} total XP)`;
}
