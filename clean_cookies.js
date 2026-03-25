const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'cookies.txt');

if (fs.existsSync(filePath)) {
    let content = fs.readFileSync(filePath, 'utf8');
    
    // Remove BOM
    const before = content.length;
    content = content.replace(/^\ufeff/, "");
    const after = content.length;
    
    if (before !== after) {
        console.log("BOM removed!");
    } else {
        console.log("No BOM found, but rewriting to ensure clean UTF-8.");
    }
    
    // Ensure it starts with # Netscape
    if (!content.startsWith("# Netscape")) {
        console.log("Warning: File does not start with # Netscape. This might be a problem.");
    }
    
    // Write back as CLEAN UTF-8 without BOM
    fs.writeFileSync(filePath, content, { encoding: 'utf8' });
    console.log("Cleanup complete.");
} else {
    console.log("cookies.txt not found.");
}
