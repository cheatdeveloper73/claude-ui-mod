import { chatgptAuth } from '../router/openai.mjs';
import { publishAccessView } from '../router/credential-authority.mjs';

try
{
    const openai = await chatgptAuth();
    await publishAccessView(openai);
    process.stdout.write('credential access view published\n');
}
catch
{
    // A fetch/parse exception must not make a credential payload a diagnostic.
    process.stderr.write('credential authority publication failed\n');
    process.exitCode = 1;
}
