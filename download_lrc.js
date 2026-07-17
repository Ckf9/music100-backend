const fs = require('fs');
const path = require('path');
const axios = require('axios');

// 1. Environment variables and configuration
const NETEASE_API_BASE = process.env.NETEASE_API_BASE || 'https://music.163.com';
const SONGS_SOURCE_DIR = process.env.SONGS_SOURCE_DIR || path.join(__dirname, '../Music100/MoreSongs');
const TARGET_DIR = process.env.TARGET_DIR || path.join(__dirname, '../Music100/karokee');
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || '3', 10);

// Helper function to estimate duration from companion LRC file
function estimateDurationMs(companionLrcPath) {
    if (!fs.existsSync(companionLrcPath)) {
        return null;
    }
    try {
        const content = fs.readFileSync(companionLrcPath, 'utf8');
        const lines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        if (lines.length === 0) return null;
        const lastLine = lines[lines.length - 1];
        const match = lastLine.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\]/);
        if (!match) return null;
        const minutes = parseInt(match[1], 10);
        const seconds = parseInt(match[2], 10);
        const msStr = match[3];
        const msVal = parseInt(msStr, 10) * (msStr.length === 2 ? 10 : 1);
        return (minutes * 60 + seconds) * 1000 + msVal;
    } catch (e) {
        console.error(`Error parsing companion lrc duration: ${e.message}`);
        return null;
    }
}

// Artist matching helpers
function cleanName(name) {
    if (!name) return '';
    return name
        .toLowerCase()
        .replace(/\((feat\.?|ft\.?|featuring|with|remix|prod\.?|produced by|edit|version)[^)]*\)/g, '')
        .replace(/\[(feat\.?|ft\.?|featuring|with|remix|prod\.?|produced by|edit|version)[^\]]*\]/g, '')
        .replace(/\b(feat\.?|ft\.?|featuring|with|remix|prod\.?|produced by|edit|version)\b.*/g, '')
        .replace(/[^a-z0-9\s,&\/+\\]/g, '') // Keep spaces and separators, remove punctuation
        .trim();
}

function splitArtists(cleanedName) {
    return cleanedName
        .split(/[,&\/+\\]+|\band\b/)
        .map(p => p.trim().replace(/\s+/g, ' ')) // normalize multiple spaces
        .filter(Boolean);
}

function artistsMatch(targetArtistStr, candidateArtists) {
    if (!targetArtistStr) return true;
    const targetCleaned = cleanName(targetArtistStr);
    const targetParts = splitArtists(targetCleaned);
    
    for (const artistObj of candidateArtists) {
        if (!artistObj || !artistObj.name) continue;
        const candidateCleaned = cleanName(artistObj.name);
        const candidateParts = splitArtists(candidateCleaned);
        
        for (const tPart of targetParts) {
            for (const cPart of candidateParts) {
                if (tPart === cPart && tPart.length > 0) {
                    return true;
                }
            }
        }
    }
    return false;
}

// Time parsing and conversion helpers
function timeToSecs(timeStr) {
    const match = timeStr.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\]/);
    if (!match) return null;
    const min = parseInt(match[1], 10);
    const sec = parseInt(match[2], 10);
    const msStr = match[3];
    const msVal = parseInt(msStr, 10) * (msStr.length === 2 ? 10 : 1);
    return min * 60 + sec + msVal / 1000;
}

function secsToTime(secs, bracketType = '<>') {
    const min = Math.floor(secs / 60);
    const remainingSecs = secs % 60;
    const minStr = String(min).padStart(2, '0');
    
    const roundedSecs = Math.round(remainingSecs * 100) / 100;
    const parts = roundedSecs.toFixed(2).split('.');
    const wholeSecsStr = parts[0].padStart(2, '0');
    const msStr = parts[1];
    
    const timeStr = `${minStr}:${wholeSecsStr}.${msStr}`;
    return bracketType === '[]' ? `[${timeStr}]` : `<${timeStr}>`;
}

function convertKlyricToEnhancedLrc(klyricText) {
    const lines = klyricText.split(/\r?\n/);
    const convertedLines = [];
    
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            convertedLines.push('');
            continue;
        }
        
        const tsMatch = trimmed.match(/^(\[(\d{2}):(\d{2})\.(\d{2,3})\])/);
        if (!tsMatch) {
            convertedLines.push(trimmed);
            continue;
        }
        
        const fullTsTag = tsMatch[1];
        const lineStartSecs = timeToSecs(fullTsTag);
        if (lineStartSecs === null) {
            convertedLines.push(trimmed);
            continue;
        }
        
        const content = trimmed.substring(fullTsTag.length).trim();
        const wordRegex = /\((\d+),(\d+)\)([^\(]+)/g;
        let match;
        const words = [];
        
        while ((match = wordRegex.exec(content)) !== null) {
            const startOffsetMs = parseInt(match[1], 10);
            const durationMs = parseInt(match[2], 10);
            const wordText = match[3].trim();
            
            const wordStartSecs = lineStartSecs + (startOffsetMs / 1000);
            const absoluteTs = secsToTime(wordStartSecs);
            
            words.push(`${absoluteTs}${wordText}`);
        }
        
        if (words.length > 0) {
            const formattedLineTs = secsToTime(lineStartSecs, '[]');
            convertedLines.push(`${formattedLineTs}${words.join(' ')}`);
        } else {
            convertedLines.push(trimmed);
        }
    }
    
    return convertedLines.join('\n');
}

// Concurrency queue implementation
async function runWithConcurrencyLimit(tasks, limit) {
    const results = [];
    const executing = new Set();
    
    for (const task of tasks) {
        const p = Promise.resolve().then(() => task());
        results.push(p);
        executing.add(p);
        
        const clean = () => executing.delete(p);
        p.then(clean, clean);
        
        if (executing.size >= limit) {
            await Promise.race(executing);
        }
    }
    
    return Promise.all(results);
}

// Process a single song
async function processSong(filename) {
    console.log(`Processing: ${filename}`);
    const ext = path.extname(filename);
    if (ext.toLowerCase() !== '.mp3') return;
    
    const baseName = path.basename(filename, ext);
    const dashIndex = baseName.indexOf(' - ');
    let artist = '';
    let title = '';
    if (dashIndex === -1) {
        title = baseName;
    } else {
        artist = baseName.substring(0, dashIndex).trim();
        title = baseName.substring(dashIndex + 3).trim();
    }
    const targetLrcPath = path.join(TARGET_DIR, artist ? `${artist} - ${title}.lrc` : `${title}.lrc`);
    
    if (fs.existsSync(targetLrcPath)) {
        console.log(`[SKIP] File already exists: ${targetLrcPath}`);
        return;
    }
    
    // Duration estimation
    const companionLrcPath = path.join(SONGS_SOURCE_DIR, artist ? `${artist} - ${title}.lrc` : `${title}.lrc`);
    const localDurationMs = estimateDurationMs(companionLrcPath);
    
    const searchQuery = baseName;
    const searchUrl = `${NETEASE_API_BASE}/api/search/pc?s=${encodeURIComponent(searchQuery)}&limit=15&type=1`;
    
    let searchData;
    try {
        const searchRes = await axios.get(searchUrl);
        searchData = searchRes.data;
    } catch (err) {
        console.error(`[Error] Search failed for "${searchQuery}": ${err.message}`);
        return;
    }
    
    if (!searchData || searchData.code !== 200 || !searchData.result || !Array.isArray(searchData.result.songs)) {
        console.log(`[No Result] No songs found for "${searchQuery}"`);
        return;
    }
    
    const candidateSongs = searchData.result.songs;
    let matchedSong = null;
    
    for (const candidate of candidateSongs) {
        // Artist Name Matching
        if (!artistsMatch(artist, candidate.artists || [])) {
            continue;
        }
        
        // Duration Matching
        if (localDurationMs !== null) {
            const candidateDuration = candidate.duration;
            if (!candidateDuration || Math.abs(candidateDuration - localDurationMs) > 5000) {
                continue;
            }
        }
        
        matchedSong = candidate;
        break;
    }
    
    if (!matchedSong) {
        console.log(`[No Match] No candidate matched the filters for "${searchQuery}"`);
        return;
    }
    
    console.log(`Matched song: ${matchedSong.name} (ID: ${matchedSong.id})`);
    
    // Fetch lyrics
    const lyricUrl = `${NETEASE_API_BASE}/api/song/lyric?id=${matchedSong.id}&lv=1&kv=1&tv=-1`;
    let lyricData;
    try {
        const lyricRes = await axios.get(lyricUrl);
        lyricData = lyricRes.data;
    } catch (err) {
        console.error(`[Error] Lyric fetch failed for "${searchQuery}" (ID: ${matchedSong.id}): ${err.message}`);
        return;
    }
    
    if (!lyricData || lyricData.code !== 200) {
        console.error(`[Error] Invalid lyric API response for "${searchQuery}" (ID: ${matchedSong.id})`);
        return;
    }
    
    let basicLrcText = '';
    if (lyricData.lrc && typeof lyricData.lrc.lyric === 'string') {
        basicLrcText = lyricData.lrc.lyric.trim();
    }
    
    if (basicLrcText) {
        const basicPath = path.join(SONGS_SOURCE_DIR, artist ? `${artist} - ${title}.lrc` : `${title}.lrc`);
        fs.writeFileSync(basicPath, basicLrcText);
        console.log(`[Success] Saved basic LRC: ${basicPath}`);
    }
    
    if (lyricData.klyric && typeof lyricData.klyric.lyric === 'string' && lyricData.klyric.lyric.trim().length > 0) {
        const klyricText = lyricData.klyric.lyric;
        
        if (/\(\d+,\d+\)/.test(klyricText)) {
            const converted = convertKlyricToEnhancedLrc(klyricText);
            
            // Align if basic LRC exists
            let finalEnhancedText = converted.trim();
            if (basicLrcText) {
                finalEnhancedText = alignLyrics(converted.trim(), basicLrcText);
            }
            
            fs.writeFileSync(targetLrcPath, finalEnhancedText);
            console.log(`[Success] Saved enhanced LRC: ${targetLrcPath}`);
            return;
        }
    }
    
    // Fallback: write basic LRC to target path if no enhanced lyrics exist
    if (basicLrcText) {
        fs.writeFileSync(targetLrcPath, basicLrcText);
        console.log(`[No Enhanced] Only basic lyrics saved to target for "${searchQuery}"`);
    } else {
        console.log(`[No Lyrics] No lyrics found at all for "${searchQuery}"`);
    }
}

function alignLyrics(klyricFormatted, basicLrc) {
    // klyricFormatted has tags like: [00:14.38] <00:14.38>Cause <00:14.59>I
    // basicLrc has tags like: [00:14.38] Cause I feel like...
    
    // Extract all timestamps from klyric
    const k_matches = [...klyricFormatted.matchAll(/<(\d{2}:\d{2}(?:\.\d+)?)>\s*([^<\[]+)/g)];
    const timestamps = k_matches.map(m => m[1]);
    
    if (timestamps.length === 0) return klyricFormatted;
    
    const lines = basicLrc.split(/\r?\n/);
    const alignedLines = [];
    let tsIndex = 0;
    
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        const lineMatch = trimmed.match(/^(\[\d{2}:\d{2}(?:\.\d+)?\])(.*)/);
        if (!lineMatch) {
            alignedLines.push(trimmed);
            continue;
        }
        
        const lineTs = lineMatch[1];
        let text = lineMatch[2].trim();
        
        // Split basic line into words
        const words = text.split(/\s+/).filter(Boolean);
        if (words.length === 0) {
            alignedLines.push(trimmed);
            continue;
        }
        
        let newLine = lineTs;
        for (let i = 0; i < words.length; i++) {
            const word = words[i];
            const ts = tsIndex < timestamps.length ? timestamps[tsIndex] : timestamps[timestamps.length - 1];
            
            if (i === 0) {
                newLine += `<${ts}>${word}`;
            } else {
                newLine += ` <${ts}>${word}`;
            }
            tsIndex++;
        }
        alignedLines.push(newLine);
    }
    
    return alignedLines.join('\n');
}

// Main runner function
async function main() {
    try {
        if (!fs.existsSync(SONGS_SOURCE_DIR)) {
            console.warn(`Source directory does not exist: ${SONGS_SOURCE_DIR}`);
            process.exit(0);
        }
        
        if (!fs.existsSync(TARGET_DIR)) {
            fs.mkdirSync(TARGET_DIR, { recursive: true });
        }
        
        const files = fs.readdirSync(SONGS_SOURCE_DIR);
        const mp3Files = files.filter(f => path.extname(f).toLowerCase() === '.mp3');
        
        if (mp3Files.length === 0) {
            console.log("No MP3 files found to process.");
            process.exit(0);
        }
        
        const tasks = mp3Files.map(filename => async () => {
            try {
                await processSong(filename);
            } catch (err) {
                console.error(`Unexpected error processing ${filename}:`, err);
            }
        });
        
        await runWithConcurrencyLimit(tasks, MAX_CONCURRENCY);
        console.log("Scraping process completed successfully.");
        process.exit(0);
    } catch (err) {
        console.error("Fatal error in scraper main:", err);
        process.exit(0); // Exit 0 even on fatal error to be robust as per requirement 8
    }
}

main();
