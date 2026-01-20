import React, { useState, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type } from "@google/genai";
import { Upload, FileText, Video, Play, Loader2, AlertCircle, Clock, FileType, CheckCircle, Image as ImageIcon } from 'lucide-react';
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
      video.src = URL.createObjectURL(file);
      video.muted = true;
      video.playsInline = true;

      const parts: any[] = [];
      
      video.onloadedmetadata = async () => {
        const duration = video.duration;
        
        // --- 核心修改：高密度採樣設定 ---
        // 1. 將目標張數提升至 800，以捕捉更細微的變化
        const targetFrameCount = 800;
        // 2. 強制最小間隔為 2 秒 (原本是 5 秒)
        const interval = Math.max(2, Math.floor(duration / targetFrameCount));
        
        setProgressStatus(`正在處理影片... (影片長度: ${Math.floor(duration)}秒, 取樣間隔: ${interval}秒, 預計張數: ${Math.ceil(duration/interval)})`);

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        if (!ctx) {
          reject(new Error("Canvas context not available"));
          return;
        }

        let currentTime = 0;

        const processFrame = async () => {
          if (currentTime >= duration) {
            URL.revokeObjectURL(video.src);
            // FIXED: Return object instead of array
            resolve({ parts, interval });
            return;
          }

          video.currentTime = currentTime;
        };

        video.onseeked = () => {
          // --- 核心修改：極限壓縮設定 ---
          // 1. 將最大邊長限制在 256px (足夠辨識大標題)
          const scale = Math.min(1, 256 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = video.videoWidth * scale;
          canvas.height = video.videoHeight * scale;
          
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          
          // 2. 將 JPEG 品質壓到 0.3 (30%) 以節省大量 Token
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
          reject(new Error("Video processing error"));
        };

        processFrame();
      };
      
      video.onerror = () => {
        reject(new Error("Could not load video metadata"));
      };
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
      
      // FIXED: Variable to store sampling interval for correction
      let samplingInterval = 0; 

      // --- 1. Process Video ---
      const isLargeVideo = videoFile.size > VIDEO_DIRECT_LIMIT_MB * 1024 * 1024;
      if (isLargeVideo) {
        console.log("Large video detected, switching to frame sampling...");
        try {
          // FIXED: Destructure the object returned by extractFrames
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
        model: 'gemini-2.5-pro',
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
              required: ["timestamp", "pdfPageNumber", "slideTitle", "reasoning"]
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
            // 自動修正：時間點往前推移半個 Interval
            const correctedSeconds = Math.max(0, event.seconds - (samplingInterval / 2));
            
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
    if (videoRef.current) {
      videoRef.current.currentTime = seconds;
      videoRef.current.play();
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 p-6 font-sans">
      <div className="max-w-5xl mx-auto space-y-8">
        
        {/* Header */}
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-bold bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
            影片與簡報同步助手 (High Precision)
          </h1>
          <p className="text-slate-400">
            上傳演講影片與 PDF 講義，AI 將自動為您找出對應的切換時間點。
          </p>
        </div>

        {/* Input Section */}
        <div className="grid md:grid-cols-2 gap-6">
          {/* Video Uploader */}
          <div className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center transition-colors ${videoFile ? 'border-blue-500 bg-blue-500/10' : 'border-slate-700 hover:border-slate-500'}`}>
            <input 
              type="file" 
              accept="video/*" 
              onChange={handleVideoUpload} 
              className="hidden" 
              id="video-upload"
            />
            <label htmlFor="video-upload" className="cursor-pointer flex flex-col items-center space-y-4 w-full">
              <div className="p-4 bg-slate-800 rounded-full">
                <Video className="w-8 h-8 text-blue-400" />
              </div>
              <div className="text-center">
                <span className="block text-lg font-medium text-white">
                  {videoFile ? videoFile.name : "選擇影片"}
                </span>
                <span className="text-sm text-slate-500">支援 MP4, MOV, WEBM (大檔案將自動取樣)</span>
              </div>
            </label>
          </div>

          {/* PDF Uploader */}
          <div className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center transition-colors ${pdfFile ? 'border-red-500 bg-red-500/10' : 'border-slate-700 hover:border-slate-500'}`}>
            <input 
              type="file" 
              accept="application/pdf" 
              onChange={handlePdfUpload} 
              className="hidden" 
              id="pdf-upload"
            />
            <label htmlFor="pdf-upload" className="cursor-pointer flex flex-col items-center space-y-4 w-full">
              <div className="p-4 bg-slate-800 rounded-full">
                <FileText className="w-8 h-8 text-red-400" />
              </div>
              <div className="text-center">
                <span className="block text-lg font-medium text-white">
                  {pdfFile ? pdfFile.name : "選擇 PDF 簡報"}
                </span>
                <span className="text-sm text-slate-500">簡報講義 (大檔案將自動轉圖)</span>
              </div>
            </label>
          </div>
        </div>

        {/* Error Message */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/50 text-red-200 p-4 rounded-lg flex items-center gap-3 animate-in fade-in slide-in-from-top-2">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <p>{error}</p>
          </div>
        )}

        {/* Action Area */}
        <div className="flex flex-col items-center space-y-6">
          <button
            onClick={handleAnalyze}
            disabled={isAnalyzing || !videoFile || !pdfFile}
            className={`
              flex items-center space-x-2 px-8 py-3 rounded-full text-lg font-semibold shadow-lg transition-all
              ${isAnalyzing || !videoFile || !pdfFile 
                ? 'bg-slate-700 text-slate-500 cursor-not-allowed' 
                : 'bg-blue-600 hover:bg-blue-500 text-white hover:scale-105 active:scale-95'}
            `}
          >
            {isAnalyzing ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                <span>分析中...</span>
              </>
            ) : (
              <>
                <Play className="w-5 h-5 fill-current" />
                <span>開始分析對齊</span>
              </>
            )}
          </button>
          
          {isAnalyzing && (
            <div className="text-center space-y-2">
              <p className="text-blue-400 font-medium animate-pulse">
                {progressStatus || "正在處理..."}
              </p>
              <p className="text-xs text-slate-500 max-w-md mx-auto">
                採樣密度：極高 (600張) | 圖片品質：壓縮 (10%) | 自動校正：開啟
              </p>
            </div>
          )}
        </div>

        {/* Video Preview */}
        {videoUrl && (
          <div className="bg-black rounded-xl overflow-hidden shadow-2xl ring-1 ring-slate-700">
            <video 
              ref={videoRef}
              src={videoUrl} 
              controls 
              className="w-full max-h-[500px] object-contain mx-auto"
            />
          </div>
        )}

        {/* Results Table */}
        {results && results.length > 0 && (
          <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-700">
            <div className="flex items-center space-x-2">
              <CheckCircle className="w-6 h-6 text-green-400" />
              <h2 className="text-2xl font-bold text-white">分析結果</h2>
            </div>
            
            <div className="bg-slate-800 rounded-xl overflow-hidden shadow-xl ring-1 ring-slate-700">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-700/50 text-slate-300 text-sm uppercase tracking-wider">
                      <th className="p-4 font-semibold w-32">時間點</th>
                      <th className="p-4 font-semibold w-32">PDF 頁碼</th>
                      <th className="p-4 font-semibold">投影片標題 / 內容</th>
                      <th className="p-4 font-semibold hidden md:table-cell">判斷依據</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700">
                    {results.map((event, idx) => (
                      <tr key={idx} className="hover:bg-slate-700/30 transition-colors group">
                        <td className="p-4">
                          <button 
                            onClick={() => jumpToTime(event.seconds)}
                            className="flex items-center space-x-2 text-blue-400 hover:text-blue-300 bg-blue-400/10 hover:bg-blue-400/20 px-3 py-1 rounded-full transition-all"
                          >
                            <Play className="w-3 h-3 fill-current" />
                            <span className="font-mono font-bold">{event.timestamp}</span>
                          </button>
                        </td>
                        <td className="p-4">
                          <div className="flex items-center space-x-2 text-white">
                            <FileType className="w-4 h-4 text-slate-400" />
                            <span className="font-bold text-lg">{event.pdfPageNumber}</span>
                          </div>
                        </td>
                        <td className="p-4">
                          <p className="font-medium text-white">{event.slideTitle}</p>
                        </td>
                        <td className="p-4 hidden md:table-cell">
                          <p className="text-sm text-slate-400">{event.reasoning}</p>
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