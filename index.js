const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const axios = require('axios');

const app = express();
app.use(cors());

// Mutex / Queue for yt-dlp to prevent OOM
class AsyncQueue {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
    }

    async enqueue(task) {
        return new Promise((resolve, reject) => {
            this.queue.push(async () => {
                try {
                    const result = await task();
                    resolve(result);
                } catch (err) {
                    reject(err);
                }
            });
            this.process();
        });
    }

    async process() {
        if (this.isProcessing || this.queue.length === 0) return;
        this.isProcessing = true;
        const task = this.queue.shift();
        try {
            await task();
        } finally {
            this.isProcessing = false;
            this.process();
        }
    }
}

const ytQueue = new AsyncQueue();

// Helper to run yt-dlp
function runYtDlp(query) {
    return new Promise((resolve, reject) => {
        const isUrl = query.startsWith('http://') || query.startsWith('https://');
        const target = isUrl ? query : `ytsearch1:${query}`;
        const command = `yt-dlp "${target}" -f "bestaudio[ext=m4a]/bestaudio" --get-url --print "%(artist)s|%(title)s|%(thumbnail)s|%(duration)s" --no-warnings --force-ipv4`;
        
        exec(command, (error, stdout, stderr) => {
            if (error) {
                return reject(new Error(stderr || error.message));
            }
            
            const lines = stdout.trim().split('\n').filter(l => l.trim().length > 0);
            if (lines.length < 2) {
                return reject(new Error('Failed to parse yt-dlp output. Stdout: ' + stdout + ' Stderr: ' + stderr));
            }
            
            const metadataLine = lines[lines.length - 2];
            const audioUrl = lines[lines.length - 1];
            const parts = metadataLine.split('|');
            
            resolve({
                artist: parts[0] || 'Unknown Artist',
                title: parts[1] || 'Unknown Title',
                thumbnail: parts[2] || '',
                duration: parseFloat(parts[3]) || 0,
                audioUrl: audioUrl
            });
        });
    });
}

// Fetch iTunes Artwork
async function getITunesArtwork(artist, title) {
    try {
        const term = encodeURIComponent(`${artist} ${title}`);
        const response = await axios.get(`https://itunes.apple.com/search?term=${term}&entity=song&limit=1`);
        if (response.data.results && response.data.results.length > 0) {
            let coverUrl = response.data.results[0].artworkUrl100;
            // Upgrade to 1000x1000 square
            if (coverUrl) {
                return coverUrl.replace('100x100bb', '1000x1000bb');
            }
        }
    } catch (e) {
        console.error('iTunes fetch error:', e.message);
    }
    return null;
}

// Fetch Synced Lyrics from LRCLIB
async function getLRCLIBLyrics(artist, title, duration) {
    try {
        let response = await axios.get(`https://lrclib.net/api/search`, {
            params: { track_name: title, artist_name: artist }
        });
        
        // Fallback to loose search if no results
        if (!response.data || response.data.length === 0) {
            let cleanTitle = title.replace(/\[.*?\]|\(.*?\)/g, '').trim();
            let searchArtist = (artist !== 'NA' && artist !== 'Unknown Artist') ? artist : '';
            let q = `${searchArtist} ${cleanTitle}`.trim();
            
            response = await axios.get(`https://lrclib.net/api/search`, {
                params: { q: q }
            });
        }
        
        if (response.data && response.data.length > 0) {
            // Find the best match: closest duration with syncedLyrics
            let bestMatch = null;
            let minDiff = Infinity;
            
            for (let track of response.data) {
                if (track.syncedLyrics) {
                    let diff = Math.abs(track.duration - duration);
                    if (diff < minDiff) {
                        minDiff = diff;
                        bestMatch = track;
                    }
                }
            }
            
            if (bestMatch && minDiff < 10) { // must be within 10 seconds to be considered correct timing
                return bestMatch.syncedLyrics;
            }
        }
    } catch (e) {
        console.error('LRCLIB fetch error:', e.message);
    }
    return "";
}

// Convert standard LRC to enhanced LRC word-by-word format
function convertToEnhancedLRC(lrcText, totalDuration) {
    if (!lrcText) return "";
    
    const lines = lrcText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const parsedLines = [];
    const pattern = /^\[(\d+):(\d+\.\d+)\](.*)$/;
    
    for (const line of lines) {
        const match = line.match(pattern);
        if (match) {
            const m = parseInt(match[1]);
            const s = parseFloat(match[2]);
            const timestamp = m * 60 + s;
            const text = match[3].trim();
            parsedLines.push({ timestamp, text, original: line });
        }
    }
    
    const enhancedLines = [];
    for (let i = 0; i < parsedLines.length; i++) {
        const item = parsedLines[i];
        const t_start = item.timestamp;
        let t_end = totalDuration;
        
        if (i + 1 < parsedLines.length) {
            t_end = parsedLines[i+1].timestamp;
        } else {
            t_end = Math.min(t_start + 4.0, totalDuration);
        }
        
        const duration = t_end - t_start;
        const words = item.text.split(/\s+/).filter(w => w.length > 0);
        
        if (words.length === 0) {
            const m_line = Math.floor(t_start / 60).toString().padStart(2, '0');
            const s_line = (t_start % 60).toFixed(2).padStart(5, '0');
            enhancedLines.push(`[${m_line}:${s_line}]`);
            continue;
        }
        
        const numWords = words.length;
        let wordDur = duration / numWords;
        if (wordDur > 0.8) wordDur = 0.8;
        if (wordDur < 0.15) wordDur = 0.15;
        
        const wordTokens = [];
        for (let j = 0; j < words.length; j++) {
            const w_time = t_start + (j * wordDur);
            const m_w = Math.floor(w_time / 60).toString().padStart(2, '0');
            const s_w = (w_time % 60).toFixed(2).padStart(5, '0');
            wordTokens.push(`<${m_w}:${s_w}>${words[j]}`);
        }
        
        const m_line = Math.floor(t_start / 60).toString().padStart(2, '0');
        const s_line = (t_start % 60).toFixed(2).padStart(5, '0');
        enhancedLines.push(`[${m_line}:${s_line}] ${wordTokens.join(' ')}`);
    }
    
    return enhancedLines.join('\n');
}

app.get('/api/track/load', async (req, res) => {
    const { query } = req.query;
    if (!query) return res.status(400).json({ error: 'Missing query parameter' });

    try {
        let cleanArtist = 'Unknown Artist';
        let cleanTitle = query;
        const dashIndex = query.indexOf(' - ');
        if (dashIndex !== -1) {
            cleanArtist = query.substring(0, dashIndex).trim();
            cleanTitle = query.substring(dashIndex + 3).trim();
        }

        const ytData = await ytQueue.enqueue(() => runYtDlp(query + " Audio"));
        
        const [itunesArt, syncedLyrics] = await Promise.all([
            getITunesArtwork(cleanArtist, cleanTitle),
            getLRCLIBLyrics(cleanArtist, cleanTitle, ytData.duration)
        ]);

        const finalCover = itunesArt || ytData.thumbnail;
        const proxyStreamUrl = `/api/track/stream?url=${encodeURIComponent(ytData.audioUrl)}`;

        res.json({
            artist: ytData.artist,
            title: ytData.title,
            coverUrl: finalCover,
            audioUrl: ytData.audioUrl,
            proxyUrl: proxyStreamUrl,
            lyrics: syncedLyrics
        });

    } catch (error) {
        console.error('Load Error:', error);
        res.status(500).json({ error: error.message || 'Failed to extract track' });
    }
});

// New endpoint: Download and generate enhanced LRC
app.get('/api/track/download_and_sync', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing url parameter' });

    try {
        console.log(`Downloading and syncing track from URL: ${url}`);
        
        // 1. Get track metadata
        const ytData = await ytQueue.enqueue(() => runYtDlp(url));
        
        // 2. Try to split the title if artist isn't clearly separated
        let cleanArtist = ytData.artist;
        let cleanTitle = ytData.title;
        if (cleanArtist === 'Unknown Artist' || !cleanArtist) {
            const dashIndex = cleanTitle.indexOf(' - ');
            if (dashIndex !== -1) {
                cleanArtist = cleanTitle.substring(0, dashIndex).trim();
                cleanTitle = cleanTitle.substring(dashIndex + 3).trim();
            }
        }
        
        // 3. Get Lyrics & Art
        const [itunesArt, standardLyrics] = await Promise.all([
            getITunesArtwork(cleanArtist, cleanTitle),
            getLRCLIBLyrics(cleanArtist, cleanTitle, ytData.duration)
        ]);
        
        // 4. Convert to Enhanced LRC
        let enhancedLyrics = "";
        if (standardLyrics) {
            enhancedLyrics = convertToEnhancedLRC(standardLyrics, ytData.duration);
        }

        // Return the direct streaming URL so iOS can save it locally
        res.json({
            artist: cleanArtist,
            title: cleanTitle,
            coverUrl: itunesArt || ytData.thumbnail,
            audioUrl: ytData.audioUrl, // Direct audio URL to download
            enhancedLyrics: enhancedLyrics
        });

    } catch (error) {
        console.error('Download and sync error:', error);
        res.status(500).json({ error: error.message || 'Failed to download and sync track' });
    }
});

// Proxy streaming endpoint - prevents Cloudflare Tunnels from breaking AVPlayer range requests
app.get('/api/track/stream', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing url');

    try {
        const range = req.headers.range;
        const headers = {};
        if (range) {
            headers['Range'] = range;
        }

        const response = await axios({
            method: 'GET',
            url: targetUrl,
            headers: headers,
            responseType: 'stream',
            validateStatus: status => status >= 200 && status < 400
        });

        // Explicitly set headers to pass safely through Cloudflare Tunnel
        res.setHeader('Accept-Ranges', 'bytes');
        if (response.headers['content-type']) {
            res.setHeader('Content-Type', response.headers['content-type']);
        }
        if (response.headers['content-length']) {
            res.setHeader('Content-Length', response.headers['content-length']);
        }
        if (response.headers['content-range']) {
            res.setHeader('Content-Range', response.headers['content-range']);
        }
        
        // Proxy status code (200 or 206)
        res.status(response.status);
        response.data.pipe(res);

    } catch (error) {
        console.error('Stream proxy error:', error.message);
        res.status(500).send('Proxy error');
    }
});

app.get('/api/search', async (req, res) => {
    const { q } = req.query;
    if (!q || !q.trim()) return res.json([]);
    try {
        const term = encodeURIComponent(q.trim());
        const response = await axios.get(`https://itunes.apple.com/search?term=${term}&entity=song&limit=15`);
        if (response.data && response.data.results) {
            const results = response.data.results.map(item => ({
                id: item.trackId,
                title: item.trackName,
                artist: item.artistName,
                coverUrl: item.artworkUrl100 ? item.artworkUrl100.replace('100x100bb', '1000x1000bb') : null
            }));
            res.json(results);
        } else {
            res.json([]);
        }
    } catch (e) {
        console.error('Search error:', e.message);
        res.json([]);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Music100 proxy backend listening on port ${PORT}`);
});
