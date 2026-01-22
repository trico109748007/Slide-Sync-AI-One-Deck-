import React, { useState, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type } from "@google/genai";
import { Upload, FileText, Video, Play, Loader2, AlertCircle, Clock, FileType, CheckCircle, Image as ImageIcon, Sparkles, ArrowRight } from 'lucide-react';
import * as pdfjsLibModule from 'pdfjs-dist';

// Handle ESM/CJS interop for pdfjs-dist
const pdfjsLib = (pdfjsLibModule as any).default || pdfjsLibModule;

// Configure PDF.js worker
if (pdfjsLib.GlobalWorkerOptions) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://esm.sh/pdfjs-dist@3.11.174/build/pdf.worker.min.js`;
}

// Define the shape of our result based on the schema we will request
interface SyncEvent {
  timestamp: string;
  seconds: number;
  pdfPageNumber: number;
  slideTitle: string;
  reasoning: string;
}

const App = () => {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [progressStatus, setProgressStatus] = useState<string>("");
  const [results, setResults] = useState<SyncEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Helper to convert file to Base64
  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const result = reader.result as string;
        if (result.includes(',')) {
          const base64 = result.split(',')[1];
          resolve(base64);
        } else {
           reject(new Error("Failed to process file data"));
        }
      };
      reader.onerror = (error) => reject(error);
    });
  };

  // Helper to determine accurate MIME type
  const getMimeType = (file: File): string => {
    const ext = file.name.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'mp4': return 'video/mp4';
      case 'mov': return 'video/quicktime';
      case 'webm': return 'video/webm';
      case 'avi': return 'video/x-msvideo';
      case 'wmv': return 'video/x-ms-wmv';
      case 'mpg':
      case 'mpeg': return 'video/mpeg';
      default: return file.type || 'application/octet-stream';
    }
  };

  // Frame extraction for large videos
  // FIXED: Return type includes 'interval' for midpoint correction
  const extractFrames = async (file: File): Promise<{ parts: any[], interval: number }> => {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;

      const parts: any[] = [];
      let objectUrl: string | null = null;
      
      const cleanup = () => {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        video.onloadedmetadata = null;
        video.onseeked = null;
        video.onerror = null;
      };

      video.onloadedmetadata = async () => {
        const duration = video.duration;
        
        // CHECK: Ensure duration is finite to prevent "currentTime is non-finite" error
        if (!Number.isFinite(duration) || duration <= 0) {
          cleanup();
          reject(new Error("無法讀取影片長度 (Duration invalid)。請確認影片檔案是否完整。"));
          return;
        }

        // --- 核心修改：高密度採樣設定 ---
        const targetFrameCount = 800;
        let interval = Math.floor(duration / targetFrameCount);
        if (!Number.isFinite(interval) || interval < 2) interval = 2; // Strict interval validation
        
        setProgressStatus(`正在處理影片... (影片長度: ${Math.floor(duration)}秒, 取樣間隔: ${interval}秒, 預計張數: ${Math.ceil(duration/interval)})`);

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        if (!ctx) {
          cleanup();
          reject(new Error("Canvas context not available"));
          return;
        }

        let currentTime = 0;

        const processFrame = async () => {
          // Safety check for recursive calls
          if (!Number.isFinite(currentTime)) {
             cleanup();
             reject(new Error("Internal Error: Calculated time is non-finite"));
             return;
          }

          if (currentTime >= duration) {
            cleanup();
            resolve({ parts, interval });
            return;
          }

          try {
            video.currentTime = currentTime;
          } catch (err) {
            cleanup();
            reject(new Error(`Failed to seek video to ${currentTime}s: ${err}`));
          }
        };

        video.onseeked = () => {
          // --- 核心修改：極限壓縮設定 ---
          const scale = Math.min(1, 256 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = video.videoWidth * scale;
          canvas.height = video.videoHeight * scale;
          
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          
          const base64Url = canvas.toDataURL('image/jpeg', 0.3);
          const base64Data = base64Url.split(',')[1];

          const mins = Math.floor(currentTime / 60);
          const secs = Math.floor(currentTime % 60);
          const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

          parts.push({ text: `[VIDEO_FRAME_TIMESTAMP: ${timeStr} (Seconds: ${Math.floor(currentTime)})]` });
          parts.push({
            inlineData: {
              mimeType: 'image/jpeg',
              data: base64Data
            }
          });

          currentTime += interval;
          setProgressStatus(`正在提取影格: ${timeStr} / ${Math.floor(duration / 60)}:${Math.floor(duration % 60).toString().padStart(2, '0')}`);
          processFrame();
        };

        video.onerror = (e) => {
          cleanup();
          reject(new Error("Video processing error during playback"));
        };

        processFrame();
      };
      
      video.onerror = () => {
        cleanup();
        reject(new Error("Could not load video metadata"));
      };

      try {
        objectUrl = URL.createObjectURL(file);
        video.src = objectUrl;
      } catch (e) {
        reject(new Error("Failed to create object URL for video file"));
      }
    });
  };

  // PDF Page Extraction for large PDFs
  const extractPdfPages = async (file: File): Promise<any[]> => {
    return new Promise(async (resolve, reject) => {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        const pdf = await loadingTask.promise;
        
        const numPages = pdf.numPages;
        const parts: any[] = [];
        
        setProgressStatus(`正在處理 PDF 頁面 (共 ${numPages} 頁)...`);

        for (let i = 1; i <= numPages; i++) {
          const page = await pdf.getPage(i);
          
          const viewport = page.getViewport({ scale: 1.5 });
          const scale = Math.min(1, 1024 / viewport.width);
          const scaledViewport = page.getViewport({ scale: 1.5 * scale });

          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          canvas.height = scaledViewport.height;
          canvas.width = scaledViewport.width;

          if (context) {
             const renderContext = {
              canvasContext: context,
              viewport: scaledViewport
            };
            await page.render(renderContext).promise;
            
            const base64Url = canvas.toDataURL('image/jpeg', 0.6); 
            const base64Data = base64Url.split(',')[1];
            
            parts.push({
               text: `[PDF_PAGE_NUMBER_${i}]`
            });
            parts.push({
              inlineData: {
                mimeType: 'image/jpeg',
                data: base64Data
              }
            });
            
            setProgressStatus(`已轉換 PDF 頁面: ${i} / ${numPages}`);
          }
        }
        resolve(parts);
      } catch (e) {
        console.error("PDF Processing Error:", e);
        reject(new Error("無法處理 PDF 檔案，請確認檔案未損壞。"));
      }
    });
  };

  const handleVideoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setVideoFile(file);
      setVideoUrl(URL.createObjectURL(file));
      setResults(null);
      setError(null);
    }
  };

  const handlePdfUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setPdfFile(e.target.files[0]);
      setResults(null);
      setError(null);
    }
  };

  const handleAnalyze = async () => {
    if (!videoFile || !pdfFile) {
      setError("請同時上傳影片和 PDF 檔案。");
      return;
    }

    if (!process.env.API_KEY) {
      setError("API Key 缺失，請檢查設定。");
      return;
    }

    const VIDEO_DIRECT_LIMIT_MB = 20; 
    const PDF_DIRECT_LIMIT_MB = 10; 

    setIsAnalyzing(true);
    setProgressStatus("正在準備檔案...");
    setError(null);
    setResults(null);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      let contentParts: any[] = [];
      
      let samplingInterval = 0; 

      // --- 1. Process Video ---
      const isLargeVideo = videoFile.size > VIDEO_DIRECT_LIMIT_MB * 1024 * 1024;
      if (isLargeVideo) {
        console.log("Large video detected, switching to frame sampling...");
        try {
          const { parts, interval } = await extractFrames(videoFile);
          contentParts = [...contentParts, ...parts];
          samplingInterval = interval; 
        } catch (e) {
          console.error(e);
          throw new Error("無法處理大型影片，請嘗試使用較小的檔案。");
        }
      } else {
        const videoBase64 = await fileToBase64(videoFile);
        const videoMimeType = getMimeType(videoFile);
        contentParts.push({
          inlineData: {
            mimeType: videoMimeType,
            data: videoBase64
          }
        });
      }

      // --- 2. Process PDF ---
      const isLargePdf = pdfFile.size > PDF_DIRECT_LIMIT_MB * 1024 * 1024;
      if (isLargePdf) {
        console.log("Large PDF detected, switching to page rendering...");
        try {
           const pdfPages = await extractPdfPages(pdfFile);
           contentParts = [...contentParts, ...pdfPages];
        } catch (e) {
           console.error(e);
           throw e;
        }
      } else {
        const pdfBase64 = await fileToBase64(pdfFile);
        contentParts.push({
          inlineData: {
            mimeType: pdfFile.type || 'application/pdf',
            data: pdfBase64
          }
        });
      }

      // --- 3. Prompt ---
      const promptText = `
      你是一個專家，擅長將演講影片與簡報投影片同步。
        
        輸入包含：
        1. 演講影片（由一系列帶有時間戳記 [VIDEO_FRAME_TIMESTAMP] 的截圖組成）。
        2. 該演講使用的 PDF 簡報（簡報的每一頁圖片，標記為 PDF_PAGE_NUMBER_x）。

        任務：
        請仔細比對影片畫面與 PDF 內容，找出影片中每一次「投影片切換」的精確時間點。
        
        重要判斷原則：
        1. **忽略開場與閒聊**：影片開頭可能包含講者介紹、等待畫面或講者特寫。請務必等到**投影片內容清晰出現在畫面上**，且與 PDF 內容相符時，才標記第一張的時間。**不要強行從 00:00 開始**。
        2. **精確對應**：請依據截圖中的 [VIDEO_FRAME_TIMESTAMP] 時間標籤來決定時間。
        3. **忽略講者切換**：如果畫面只是從投影片切換回講者（而投影片沒變），請忽略該次變化。

        輸出規則：
        1. 輸出一個 JSON 事件列表。每個事件代表一個投影片展示的片段。
        2. 包含時間戳記 (MM:SS)、對應的 PDF 頁碼 (整數)、投影片標題(或主要內容摘要)，以及你判斷匹配的理由。
        3. 理由請使用繁體中文撰寫，解釋為何該畫面與該頁匹配（例如：標題相同、圖表一致）。
        4. 確保列表按照時間順序排列。 
      `;

      contentParts.push({ text: promptText });

      setProgressStatus("AI 正在分析與同步 (這可能需要一點時間)...");

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: {
          parts: contentParts
        },
        config: {
          responseMimeType: "application/json",
          thinkingConfig: { thinkingBudget: 1024 }, 
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                timestamp: { type: Type.STRING, description: "Slide start time (MM:SS)" },
                seconds: { type: Type.NUMBER, description: "Start time in total seconds" },
                pdfPageNumber: { type: Type.INTEGER, description: "PDF page number (1-based)" },
                slideTitle: { type: Type.STRING, description: "Title of the slide" },
                reasoning: { type: Type.STRING, description: "Reason for matching (Traditional Chinese)" }
              },
              required: ["timestamp", "seconds", "pdfPageNumber", "slideTitle", "reasoning"]
            }
          }
        }
      });

      if (response.text) {
        let data = JSON.parse(response.text) as SyncEvent[];

        // --- 核心修改：中間值校正演算法 ---
        if (samplingInterval > 0) {
          console.log(`應用中間值校正: 自動扣除 ${samplingInterval / 2} 秒 (採樣間隔: ${samplingInterval}秒)`);
          
          data = data.map(event => {
            // --- 修正後的邏輯 ---
            let s = Number(event.seconds);
            
            // 如果秒數無效 (AI 沒回傳)，嘗試從 timestamp (MM:SS) 解析
            if (!Number.isFinite(s)) {
              if (event.timestamp && event.timestamp.includes(':')) {
                const parts = event.timestamp.split(':');
                const mins = parseInt(parts[0], 10);
                const secs = parseInt(parts[1], 10);
                if (!isNaN(mins) && !isNaN(secs)) {
                  s = mins * 60 + secs;
                } else {
                  s = 0; // 解析失敗才歸零
                }
              } else {
                s = 0; // 真的沒救了才歸零
              }
            }
            // -------------------

            const correctedSeconds = Math.max(0, s - (samplingInterval / 2));
            const mins = Math.floor(correctedSeconds / 60);
            const secs = Math.floor(correctedSeconds % 60);
            const correctedTimestamp = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

            return {
              ...event,
              seconds: correctedSeconds,
              timestamp: correctedTimestamp,
              reasoning: event.reasoning + ` (已自動校正誤差)`
            };
          });
        }
        
        setResults(data);
      } else {
        throw new Error("模型未返回任何數據。");
      }

    } catch (err: any) {
      console.error(err);
      const msg = err.message || '';
      
      if (msg.includes('413') || msg.includes('too large')) {
         setError("檔案總量過大。請嘗試減少影片長度或壓縮 PDF。");
      } else if (msg.includes('400')) {
         setError("請求失敗 (400)。Context Token 超出上限，請確認圖片壓縮設定已生效。");
      } else {
        setError(msg || "分析過程中發生未預期的錯誤。");
      }
    } finally {
      setIsAnalyzing(false);
      setProgressStatus("");
    }
  };

  const jumpToTime = (seconds: number) => {
    if (videoRef.current && Number.isFinite(seconds)) {
      videoRef.current.currentTime = seconds;
      videoRef.current.play();
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-800 font-sans selection:bg-teal-100 selection:text-teal-900 pb-20">
      <div className="max-w-4xl mx-auto px-6 pt-16 space-y-12">
        
        {/* Header - Clean & Minimal */}
        <div className="text-center space-y-4">
          <div className="inline-flex items-center justify-center p-3 rounded-2xl bg-white shadow-sm mb-4">
            <Sparkles className="w-6 h-6 text-teal-400" />
          </div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-gray-900">
            Slide Sync <span className="text-transparent bg-clip-text bg-gradient-to-r from-teal-400 to-purple-400">AI</span>
          </h1>
          <p className="text-gray-500 text-lg max-w-lg mx-auto leading-relaxed">
            上傳演講影片與 PDF 講義，體驗極致流暢的智能同步。
          </p>
        </div>

        {/* Input Section - Card Based */}
        <div className="grid md:grid-cols-2 gap-6">
          {/* Video Uploader */}
          <div className={`
            group relative overflow-hidden rounded-3xl transition-all duration-300
            bg-white border-2 
            ${videoFile ? 'border-teal-400 shadow-lg shadow-teal-100/50' : 'border-dashed border-gray-200 hover:border-teal-200 hover:shadow-lg hover:shadow-gray-100'}
          `}>
            <input 
              type="file" 
              accept="video/*" 
              onChange={handleVideoUpload} 
              className="hidden" 
              id="video-upload"
            />
            <label htmlFor="video-upload" className="cursor-pointer flex flex-col items-center justify-center p-10 h-full w-full relative z-10">
              <div className={`
                p-4 rounded-2xl mb-4 transition-colors duration-300
                ${videoFile ? 'bg-teal-50 text-teal-500' : 'bg-gray-50 text-gray-400 group-hover:bg-teal-50 group-hover:text-teal-400'}
              `}>
                <Video className="w-8 h-8" />
              </div>
              <div className="text-center space-y-1">
                <span className={`block font-semibold text-lg transition-colors ${videoFile ? 'text-teal-600' : 'text-gray-700'}`}>
                  {videoFile ? videoFile.name : "選擇影片"}
                </span>
                <span className="block text-sm text-gray-400">支援 MP4, MOV, WEBM</span>
              </div>
            </label>
            {videoFile && <div className="absolute inset-0 bg-teal-50/20 pointer-events-none" />}
          </div>

          {/* PDF Uploader */}
          <div className={`
            group relative overflow-hidden rounded-3xl transition-all duration-300
            bg-white border-2 
            ${pdfFile ? 'border-purple-400 shadow-lg shadow-purple-100/50' : 'border-dashed border-gray-200 hover:border-purple-200 hover:shadow-lg hover:shadow-gray-100'}
          `}>
            <input 
              type="file" 
              accept="application/pdf" 
              onChange={handlePdfUpload} 
              className="hidden" 
              id="pdf-upload"
            />
            <label htmlFor="pdf-upload" className="cursor-pointer flex flex-col items-center justify-center p-10 h-full w-full relative z-10">
              <div className={`
                p-4 rounded-2xl mb-4 transition-colors duration-300
                ${pdfFile ? 'bg-purple-50 text-purple-500' : 'bg-gray-50 text-gray-400 group-hover:bg-purple-50 group-hover:text-purple-400'}
              `}>
                <FileText className="w-8 h-8" />
              </div>
              <div className="text-center space-y-1">
                <span className={`block font-semibold text-lg transition-colors ${pdfFile ? 'text-purple-600' : 'text-gray-700'}`}>
                  {pdfFile ? pdfFile.name : "選擇簡報"}
                </span>
                <span className="block text-sm text-gray-400">PDF 格式講義</span>
              </div>
            </label>
            {pdfFile && <div className="absolute inset-0 bg-purple-50/20 pointer-events-none" />}
          </div>
        </div>

        {/* Error Message - Soft Alert */}
        {error && (
          <div className="bg-red-50 border border-red-100 text-red-600 px-6 py-4 rounded-2xl flex items-center gap-4 shadow-sm animate-in fade-in slide-in-from-top-2">
            <div className="p-2 bg-red-100 rounded-full">
              <AlertCircle className="w-5 h-5" />
            </div>
            <p className="font-medium">{error}</p>
          </div>
        )}

        {/* Action Area - Minimalist Button */}
        <div className="flex flex-col items-center space-y-8">
          <button
            onClick={handleAnalyze}
            disabled={isAnalyzing || !videoFile || !pdfFile}
            className={`
              group relative overflow-hidden px-10 py-4 rounded-2xl text-lg font-bold tracking-wide transition-all duration-300
              ${isAnalyzing || !videoFile || !pdfFile 
                ? 'bg-gray-100 text-gray-400 cursor-not-allowed' 
                : 'bg-gradient-to-r from-teal-400 to-purple-400 text-white shadow-lg shadow-purple-200 hover:shadow-xl hover:scale-[1.02] hover:-translate-y-0.5'}
            `}
          >
            <div className="relative z-10 flex items-center space-x-3">
              {isAnalyzing ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>智能分析中...</span>
                </>
              ) : (
                <>
                  <span>開始同步分析</span>
                  <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                </>
              )}
            </div>
          </button>
          
          {isAnalyzing && (
            <div className="text-center space-y-3 w-full max-w-md">
              <p className="text-transparent bg-clip-text bg-gradient-to-r from-teal-500 to-purple-500 font-semibold animate-pulse">
                {progressStatus || "正在處理..."}
              </p>
              <div className="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-teal-400 to-purple-400 animate-progress origin-left w-full" style={{animationDuration: '3s'}}></div>
              </div>
              <p className="text-xs text-gray-400">
                高精度模式啟動 • 自動時間校正 • 智能影像壓縮
              </p>
            </div>
          )}
        </div>

        {/* Video Preview - Floating Card */}
        {videoUrl && (
          <div className="bg-white p-2 rounded-3xl shadow-[0_20px_50px_-12px_rgba(0,0,0,0.1)] border border-gray-100 overflow-hidden">
            <video 
              ref={videoRef}
              src={videoUrl} 
              controls 
              className="w-full max-h-[500px] object-contain rounded-2xl bg-black"
            />
          </div>
        )}

        {/* Results Table - Clean & Airy */}
        {results && results.length > 0 && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-8 duration-700">
            <div className="flex items-center space-x-3 px-2">
              <div className="p-2 bg-teal-50 rounded-full">
                <CheckCircle className="w-6 h-6 text-teal-500" />
              </div>
              <h2 className="text-2xl font-bold text-gray-800">分析完成</h2>
            </div>
            
            <div className="bg-white rounded-3xl overflow-hidden shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-gray-100">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-gray-50/50 text-gray-500 text-xs font-bold uppercase tracking-widest border-b border-gray-100">
                      <th className="p-6 w-32">時間軸</th>
                      <th className="p-6 w-28 text-center">頁碼</th>
                      <th className="p-6">內容摘要</th>
                      <th className="p-6 hidden md:table-cell w-1/3">AI 判斷依據</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {results.map((event, idx) => (
                      <tr key={idx} className="hover:bg-teal-50/30 transition-colors duration-200 group">
                        <td className="p-6">
                          <button 
                            onClick={() => jumpToTime(event.seconds)}
                            className="flex items-center space-x-2 text-teal-600 bg-teal-50 hover:bg-teal-100 hover:text-teal-700 px-4 py-2 rounded-xl transition-all duration-200 font-mono text-sm font-bold shadow-sm"
                          >
                            <Play className="w-3 h-3 fill-current" />
                            <span>{event.timestamp}</span>
                          </button>
                        </td>
                        <td className="p-6 text-center">
                          <div className="inline-flex flex-col items-center justify-center w-12 h-12 rounded-2xl bg-purple-50 text-purple-600 border border-purple-100">
                            <span className="text-lg font-bold leading-none">{event.pdfPageNumber}</span>
                          </div>
                        </td>
                        <td className="p-6">
                          <p className="font-bold text-gray-800 text-lg group-hover:text-teal-700 transition-colors">{event.slideTitle}</p>
                        </td>
                        <td className="p-6 hidden md:table-cell">
                          <p className="text-sm text-gray-500 leading-relaxed">{event.reasoning}</p>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);