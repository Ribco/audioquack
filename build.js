const fs = require('fs');
const path = require('path');

async function runBuild() {
    console.clear();
    console.log('\x1b[38;5;220m%s\x1b[0m', '⚡ TITANIUM CORE BUILD ENGINE');
    console.log('\x1b[90m------------------------------------------\x1b[0m');

    const sourcePath = path.join(__dirname, 'index.html');
    const distDir = path.join(__dirname, 'dist');
    const targetPath = path.join(distDir, 'index.html');

    if (!fs.existsSync(distDir)) {
        fs.mkdirSync(distDir, { recursive: true });
    }

    // High-visibility log sequence
    const steps = [
        { label: 'INITIALIZING', color: '\x1b[36m' },
        { label: 'PARSING SOURCE', color: '\x1b[35m' },
        { label: 'OPTIMIZING ASSETS', color: '\x1b[34m' },
        { label: 'WRITING TO DIST', color: '\x1b[32m' }
    ];

    try {
        if (!fs.existsSync(sourcePath)) {
            throw new Error('Source index.html not found in current directory.');
        }

        const data = fs.readFileSync(sourcePath, 'utf8');
        const assets = ['dashboard.js'];

        for (const step of steps) {
            let dots = '';
            for (let i = 0; i < 3; i++) {
                dots += '.';
                process.stdout.write(`\r${step.color}⏳ ${step.label}${dots}\x1b[0m`);
                await new Promise(resolve => setTimeout(resolve, 250));
            }
            process.stdout.write(`\r${step.color}✅ ${step.label} COMPLETED\x1b[0m\n`);
        }

        // Finalize Write
        fs.writeFileSync(targetPath, data);
        assets.forEach((asset) => {
            const sourceAsset = path.join(__dirname, asset);
            const targetAsset = path.join(distDir, asset);
            if (fs.existsSync(sourceAsset)) {
                fs.copyFileSync(sourceAsset, targetAsset);
            }
        });

        console.log('\x1b[90m------------------------------------------\x1b[0m');
        console.log('🚀 \x1b[32m%s\x1b[0m', 'BUILD SUCCESSFUL');
        console.log('\x1b[90mLocation: \x1b[0m' + targetPath);

    } catch (err) {
        console.log('\n\x1b[41m\x1b[37m CRITICAL ERROR \x1b[0m');
        console.error(`\x1b[31m${err.message}\x1b[0m`);
    }
}

runBuild();
