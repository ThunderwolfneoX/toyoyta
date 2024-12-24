const crypto = require('crypto');

// Konfigurasi langsung di hardcode
const AES_KEY = Buffer.from("1a3fF6v89Vxe7def", "utf8");
const AES_IV = Buffer.from("abcdef1234567890", "utf8");
const atuwokzMap = {
    "1245": "0",
    "9268": "1",
    "2475": "2",
    "1576": "3",
    "7586": "4",
    "9148": "5",
    "1329": "6",
    "2128": "7",
    "4765": "8",
    "5890": "9",
    "22": "_",
    "1246": ",",
    "2121": "."
};

// Fungsi untuk mendekripsi data terenkripsi AES
function decryptAES(encryptedBase64) {
    try {
        const encryptedData = Buffer.from(encryptedBase64, "base64");
        const decipher = crypto.createDecipheriv("aes-128-cbc", AES_KEY, AES_IV);
        decipher.setAutoPadding(false);
        let decrypted = Buffer.concat([
            decipher.update(encryptedData),
            decipher.final()
        ]);
        return decrypted.toString("utf8").trim();
    } catch (error) {
        console.error("Error saat dekripsi AES:", error.message);
        throw new Error("Gagal mendekripsi data AES.");
    }
}

// Fungsi untuk mendekode string hasil dekripsi sebagai Base64
function decodeBase64(data) {
    try {
        return Buffer.from(data, "base64").toString("utf8");
    } catch (error) {
        console.error("Error saat decode Base64:", error.message);
        throw new Error("Gagal mendekode data sebagai Base64.");
    }
}

// Fungsi untuk mendekode hasil menjadi data asli menggunakan atuwokzMap
function atuwokzDecode(data) {
    let result = "";
    let buffer = "";

    for (let char of data) {
        buffer += char;
        if (atuwokzMap[buffer] !== undefined) {
            result += atuwokzMap[buffer];
            buffer = "";
        } else if (buffer.length > 4) {
            throw new Error(`Kode tidak valid: '${buffer}'`);
        }
    }

    if (buffer !== "") {
        throw new Error("Kode tidak lengkap.");
    }

    return result;
}

module.exports = { decryptAES, decodeBase64, atuwokzDecode };
