/** What is wrong with a part, an embed, or a picture, in the server's or the schema's own words, under it. */

import { Text } from '@mantine/core';

export function PartProblems({ problems, mt = 2 }: { readonly problems: readonly string[]; readonly mt?: number }) {
    // By position: one part can be refused twice in the same words.
    return problems.map((problem, index) => (
        <Text key={index} size="11.5px" c="red.4" mt={mt}>
            {problem}
        </Text>
    ));
}
