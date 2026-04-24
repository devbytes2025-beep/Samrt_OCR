import { useState, useRef, ChangeEvent, useEffect, useCallback } from 'react';
import { 
  Upload, 
  Image as ImageIcon, 
  FileText, 
  Download, 
  Loader2, 
  CheckCircle2, 
  X, 
  FolderUp, 
  FileUp, 
  FileSpreadsheet, 
  AlertTriangle, 
  Home, 
  History as HistoryIcon, 
  Search, 
  Check, 
  Clock, 
  Zap, 
  ShieldCheck,
  TrendingUp,
  ArrowRight,
  Layers
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI, Type } from '@google/genai';
import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Toaster, toast } from 'sonner';

// Initialize with modern SDK pattern
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

interface ExtractedData {
  keyword: string;
  value: string;
  confidence: number;
}

interface VerificationRow {
  UTR: string;
  Amount: string;
  Date?: string;
  [key: string]: any;
}

interface ProcessedFile {
  id: string;
  file: File;
  previewUrl: string;
  status: 'idle' | 'processing' | 'success' | 'needs_review' | 'error';
  data: ExtractedData[] | null;
  errorMessage?: string;
  processingTime?: number;
  verificationResult?: {
    matched: boolean;
    matchedRow?: any;
    percentage: number;
    remarks: string;
    verifiedUTR?: string;
  };
}

type Tab = 'home' | 'standard' | 'verification' | 'history';

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('home');
  const [files, setFiles] = useState<ProcessedFile[]>([]);
  const [keywords, setKeywords] = useState<string>('UTR, Amount, Date, Reference Number');
  const [isExtracting, setIsExtracting] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number>(0);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [excelData, setExcelData] = useState<VerificationRow[] | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  
  // Timer states
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState<number>(0);
  const [totalEstimatedTime, setTotalEstimatedTime] = useState<number>(0);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const excelInputRef = useRef<HTMLInputElement>(null);

  // Auto-timer effect for the progress bar and ETA
  useEffect(() => {
    let interval: any;
    if (isExtracting && startTime) {
      interval = setInterval(() => {
        setElapsedTime(Date.now() - startTime);
      }, 100);
    }
    return () => clearInterval(interval);
  }, [isExtracting, startTime]);

  useEffect(() => {
    const savedHistory = localStorage.getItem('ocr_history');
    if (savedHistory) {
      setHistory(JSON.parse(savedHistory).slice(0, 50));
    }
  }, []);

  const saveToHistory = (type: string, fileCount: number, timeTaken: number) => {
    const newEntry = {
      id: Date.now(),
      date: new Date().toLocaleString(),
      type,
      fileCount,
      timeTaken: (timeTaken / 1000).toFixed(1) + 's'
    };
    const updatedHistory = [newEntry, ...history].slice(0, 50);
    setHistory(updatedHistory);
    localStorage.setItem('ocr_history', JSON.stringify(updatedHistory));
  };

  const clearAll = () => {
    files.forEach(f => URL.revokeObjectURL(f.previewUrl));
    setFiles([]);
    setGlobalError(null);
    setProgress(0);
    setExcelData(null);
    setElapsedTime(0);
    setStartTime(null);
    toast.info('All data cleared from session.');
  };

  const handleFilesAdded = (newFiles: FileList | File[]) => {
    const validFiles = Array.from(newFiles).filter(f => f.type.startsWith('image/'));
    
    if (validFiles.length === 0) {
      setGlobalError('Please upload valid receipt images (JPG, PNG).');
      return;
    }

    const newProcessedFiles: ProcessedFile[] = validFiles.map(file => ({
      id: Math.random().toString(36).substring(7) + Date.now().toString(),
      file,
      previewUrl: URL.createObjectURL(file),
      status: 'idle',
      data: null
    }));

    setFiles(prev => [...prev, ...newProcessedFiles]);
    setGlobalError(null);
    toast.success(`${validFiles.length} file(s) added successfully.`);
  };

  const calculateFuzzyMatch = (str1: string, str2: string) => {
    if (!str1 || !str2) return 0;
    const s1 = String(str1).toLowerCase().replace(/[^a-z0-9]/g, '');
    const s2 = String(str2).toLowerCase().replace(/[^a-z0-9]/g, '');
    
    if (s1 === s2) return 100;
    if (s1.includes(s2) || s2.includes(s1)) return 85;

    let matches = 0;
    const minLength = Math.min(s1.length, s2.length);
    for (let i = 0; i < minLength; i++) {
        if (s1[i] === s2[i]) matches++;
    }
    return (matches / Math.max(s1.length, s2.length)) * 100;
  };

  const verifyDataRow = useCallback((extracted: ExtractedData[], excelRows: VerificationRow[]) => {
    const extractedUTR = extracted.find(d => d.keyword.toLowerCase().includes('utr') || d.keyword.toLowerCase().includes('ref'))?.value || '';
    const extractedAmount = extracted.find(d => d.keyword.toLowerCase().includes('amount'))?.value || '';

    let bestMatch: any = null;
    let highestScore = 0;

    for (const row of excelRows) {
      const excelUTRs = String(row.UTR || '').split(/[\/,]/).map(u => u.trim());
      
      for (const excelUTR of excelUTRs) {
        const utrScore = calculateFuzzyMatch(extractedUTR, excelUTR);
        const amountMatch = String(extractedAmount).replace(/[^0-9.]/g, '') === String(row.Amount).replace(/[^0-9.]/g, '');
        
        let score = utrScore;
        if (amountMatch) score += 20;

        if (score > highestScore) {
          highestScore = score;
          bestMatch = { row, excelUTR, score };
        }
      }
    }

    if (bestMatch && bestMatch.score >= 45) {
      const remarks = bestMatch.score >= 90 ? 'High Confidence Match' : `Possible Match (${Math.round(bestMatch.score)}%). Verify: ${bestMatch.excelUTR}`;
      return {
        matched: true,
        matchedRow: bestMatch.row,
        percentage: Math.round(bestMatch.score),
        remarks,
        verifiedUTR: bestMatch.excelUTR
      };
    }

    return {
      matched: false,
      percentage: Math.round(highestScore),
      remarks: 'No alignment found. Manual verification required.'
    };
  }, []);

  const processSingleFile = async (fileObj: ProcessedFile) => {
    const fileStartTime = Date.now();
    setFiles(prev => prev.map(f => f.id === fileObj.id ? { ...f, status: 'processing', errorMessage: undefined } : f));

    try {
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve) => {
        reader.onload = () => resolve((reader.result as string).split(',')[1]);
        reader.readAsDataURL(fileObj.file);
      });
      const base64Image = await base64Promise;

      const prompt = `Extract exactly these fields: ${keywords}. Also look for UTR/Transaction ID variations. Return JSON array: [{keyword, value, confidence}]. Confidence 0-100. If missing, value="Not found".`;

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: {
          parts: [
            { inlineData: { data: base64Image, mimeType: fileObj.file.type } },
            { text: prompt }
          ]
        },
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                keyword: { type: Type.STRING },
                value: { type: Type.STRING },
                confidence: { type: Type.NUMBER }
              },
              required: ["keyword", "value", "confidence"]
            }
          }
        }
      });

      const parsedData = JSON.parse(response.text) as ExtractedData[];
      let vResult = undefined;
      
      if (activeTab === 'verification' && excelData) {
        vResult = verifyDataRow(parsedData, excelData);
      }

      const needsReview = parsedData.some(d => d.value === 'Not found' || d.confidence < 60) || 
                          (activeTab === 'verification' && (!vResult || !vResult.matched));

      setFiles(prev => prev.map(f => f.id === fileObj.id ? { 
        ...f, 
        status: needsReview ? 'needs_review' : 'success', 
        data: parsedData,
        verificationResult: vResult,
        processingTime: Date.now() - fileStartTime
      } : f));
      
      if (needsReview) {
        toast.warning(`File ${fileObj.file.name} requires manual review.`, {
          description: vResult?.remarks || 'Low confidence or missing fields.'
        });
      } else {
        toast.success(`Processed: ${fileObj.file.name}`);
      }

      return true;
    } catch (err) {
      console.error(err);
      setFiles(prev => prev.map(f => f.id === fileObj.id ? { ...f, status: 'error', errorMessage: 'Processing failed.' } : f));
      toast.error(`Error processing ${fileObj.file.name}`);
      return false;
    }
  };

  const handleExtractBatch = async () => {
    const pending = files.filter(f => f.status === 'idle' || f.status === 'error' || f.status === 'needs_review');
    if (pending.length === 0) {
      toast.info('No pending files to process.');
      return;
    }

    toast.info(`Starting batch processing for ${pending.length} file(s)...`);
    setIsExtracting(true);
    setStartTime(Date.now());
    setProgress(0);
    setElapsedTime(0);
    
    // Estimate: ~2 seconds per image in parallel mode
    setTotalEstimatedTime(pending.length * 2000 / 2); 

    let completed = 0;
    const concurrencyLimit = 2; // Process 2 at a time for speed vs stability
    
    for (let i = 0; i < pending.length; i += concurrencyLimit) {
      const chunk = pending.slice(i, i + concurrencyLimit);
      await Promise.all(chunk.map(file => processSingleFile(file)));
      completed += chunk.length;
      setProgress(Math.round((completed / pending.length) * 100));
    }

    const totalDuration = Date.now() - (startTime || Date.now());
    setIsExtracting(false);
    saveToHistory(activeTab === 'standard' ? 'Batch OCR' : 'Verification', files.length, totalDuration);
    toast.success('Batch processing complete!', {
      description: `Processed ${files.length} files in ${(totalDuration / 1000).toFixed(1)}s`
    });
    setTimeout(() => setProgress(0), 1000);
  };

  const formatTime = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const downloadExcel = () => {
    const rows = files.map(f => {
      const row: any = { 'Filename': f.file.name, 'Status': f.status.toUpperCase() };
      
      // Add OCR extracted data
      f.data?.forEach(d => row[d.keyword] = d.value);
      
      // Add Verification specific columns
      if (f.verificationResult) {
        row['Verified UTR'] = f.verificationResult.verifiedUTR || '—';
        row['Accuracy %'] = f.verificationResult.percentage + '%';
        
        // Include reference amount and date if matched
        if (f.verificationResult.matched && f.verificationResult.matchedRow) {
          row['Ref Amount'] = f.verificationResult.matchedRow.Amount || '—';
          row['Ref Date'] = f.verificationResult.matchedRow.Date || '—';
        } else {
          row['Ref Amount'] = '—';
          row['Ref Date'] = '—';
        }
        
        row['Audit Note'] = f.verificationResult.remarks;
      }
      return row;
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "OCR_Audit");
    
    const filename = activeTab === 'verification' 
      ? `Verification_Audit_${Date.now()}.xlsx` 
      : `Batch_OCR_Export_${Date.now()}.xlsx`;
      
    XLSX.writeFile(wb, filename);
  };

  const downloadPDF = () => {
    const doc = new jsPDF('landscape');
    const title = activeTab === 'verification' ? "SmartOCR Verification & Audit Report" : "SmartOCR Batch Processing Report";
    doc.text(title, 14, 15);
    
    // Get unique keywords across all files
    const allKeywords = new Set<string>();
    files.forEach(f => f.data?.forEach(d => allKeywords.add(d.keyword)));
    const keywordsList = Array.from(allKeywords);
    
    const isVerification = activeTab === 'verification';
    const head = [
      ['File Name', 'Status', ...keywordsList, 
       ...(isVerification ? ['Ref Amount', 'Ref Date'] : []),
       'Match %', 'Notes']
    ];
    
    const body = files.map(f => {
      const row = [
        f.file.name, 
        f.status.toUpperCase(),
      ];
      keywordsList.forEach(kw => {
        const found = f.data?.find(d => d.keyword === kw);
        row.push(found ? found.value : '-');
      });
      
      if (isVerification) {
        row.push(f.verificationResult?.matched ? String(f.verificationResult.matchedRow.Amount || '-') : '-');
        row.push(f.verificationResult?.matched ? String(f.verificationResult.matchedRow.Date || '-') : '-');
      }
      
      row.push(f.verificationResult ? `${f.verificationResult.percentage}%` : '-');
      row.push(f.verificationResult ? f.verificationResult.remarks : '-');
      return row;
    });

    autoTable(doc, {
      head: head,
      body: body,
      startY: 20,
      styles: { fontSize: 8 },
      headStyles: { fillColor: [79, 70, 229], textColor: 255 },
      alternateRowStyles: { fillColor: [248, 250, 252] },
    });
    
    const filename = isVerification 
      ? `Verification_Report_${Date.now()}.pdf` 
      : `Batch_OCR_Report_${Date.now()}.pdf`;
      
    doc.save(filename);
  };

  const hasProcessedFiles = files.some(f => f.status === 'success' || f.status === 'needs_review');
  const stats = {
    total: files.length,
    success: files.filter(f => f.status === 'success').length,
    review: files.filter(f => f.status === 'needs_review').length,
    error: files.filter(f => f.status === 'error').length,
  };

  return (
    <div className="min-h-screen bg-white text-slate-900 pb-20 selection:bg-indigo-100 flex flex-col font-sans">
      <input type="file" multiple accept="image/*" ref={fileInputRef} onChange={(e) => e.target.files && handleFilesAdded(e.target.files)} className="hidden" />
      <input type="file" {...{ webkitdirectory: "", directory: "" } as any} ref={folderInputRef} onChange={(e) => e.target.files && handleFilesAdded(e.target.files)} className="hidden" />
      <input type="file" accept=".xlsx,.xls" ref={excelInputRef} onChange={(e) => {
         const file = e.target.files?.[0];
         if (file) {
           const reader = new FileReader();
           reader.onload = (evt) => {
             const bstr = evt.target?.result;
             const wb = XLSX.read(bstr, { type: 'binary' });
             const ws = wb.Sheets[wb.SheetNames[0]];
             const data = XLSX.utils.sheet_to_json(ws) as VerificationRow[];
             setExcelData(data);
             setGlobalError(null);
             toast.success('Master Data Log loaded successfully!', {
               description: `${data.length} records found for verification.`
             });
           };
           reader.readAsBinaryString(file);
         }
      }} className="hidden" />

      <Toaster position="top-right" expand={false} richColors closeButton />

      {/* Navigation Header */}
      <header className="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b border-slate-100 px-6 lg:px-12">
        <div className="max-w-7xl mx-auto h-20 flex items-center justify-between">
          <div className="flex items-center gap-12">
            <div className="flex items-center gap-3 cursor-pointer select-none" onClick={() => { setActiveTab('home'); clearAll(); }}>
              <div className="bg-slate-900 p-2 rounded-xl shadow-lg">
                <Zap className="w-5 h-5 text-indigo-400" />
              </div>
              <div>
                <h1 className="text-lg font-bold tracking-tight text-slate-900 leading-none">Smart<span className="text-indigo-600">OCR</span></h1>
                <p className="text-[9px] font-black text-slate-400 tracking-[0.2em] mt-1">BATCH PROCESSOR</p>
              </div>
            </div>

            <nav className="hidden md:flex items-center gap-2">
              {[
                { id: 'home', label: 'Dashboard', icon: Home },
                { id: 'standard', label: 'Extract', icon: Layers },
                { id: 'verification', label: 'Verify', icon: ShieldCheck },
                { id: 'history', label: 'History', icon: HistoryIcon }
              ].map(t => (
                <button
                  key={t.id}
                  onClick={() => { setActiveTab(t.id as Tab); clearAll(); }}
                  className={`flex items-center gap-2 px-4 py-2 rounded-xl text-[13px] font-bold transition-all cursor-pointer ${activeTab === t.id ? 'bg-slate-900 text-white shadow-xl' : 'text-slate-500 hover:text-slate-900 hover:bg-slate-50'}`}
                >
                  <t.icon className="w-3.5 h-3.5" /> {t.label}
                </button>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-3">
            {hasProcessedFiles && (
              <>
                <button onClick={downloadExcel} className="bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-2.5 rounded-xl text-[11px] font-black flex items-center gap-2 transition-all shadow-lg active:scale-95 cursor-pointer">
                  <Download className="w-4 h-4" /> EXCEL
                </button>
                <button onClick={downloadPDF} className="bg-rose-600 hover:bg-rose-700 text-white px-5 py-2.5 rounded-xl text-[11px] font-black flex items-center gap-2 transition-all shadow-lg active:scale-95 cursor-pointer">
                  <Download className="w-4 h-4" /> PDF
                </button>
              </>
            )}
            <div className="w-8 h-8 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center text-[10px] font-bold text-slate-400">JD</div>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl mx-auto w-full px-6 lg:px-12 py-10">
        <AnimatePresence mode="wait">
          {activeTab === 'home' && (
            <motion.div key="home" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="py-20 flex flex-col items-center text-center space-y-10">
              <div className="space-y-6 max-w-3xl">
                <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-indigo-50 text-indigo-700 text-[10px] font-black uppercase tracking-[0.2em] rounded-full border border-indigo-100">Professional Finance Engine</div>
                <h2 className="text-6xl font-bold tracking-tight text-slate-900 leading-[1.1]">The smartest way to <br/><span className="text-indigo-600">reconcile batch payments.</span></h2>
                <p className="text-lg text-slate-500 font-medium leading-relaxed max-w-2xl mx-auto">
                  Extract Transaction IDs, Amounts, and Dates from images in seconds. 
                  Zero storage. Ultra-fast processing. Privacy first.
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-4">
                <button onClick={() => setActiveTab('standard')} className="bg-slate-900 text-white px-10 py-5 rounded-2xl font-bold text-lg shadow-2xl hover:scale-105 transition-all flex items-center gap-3 active:scale-95 cursor-pointer">
                  Launch Batch OCR <ArrowRight className="w-5 h-5" />
                </button>
                <button onClick={() => setActiveTab('verification')} className="bg-white border-2 border-slate-100 text-slate-900 px-10 py-5 rounded-2xl font-bold text-lg hover:bg-slate-50 transition-all shadow-sm active:scale-95 cursor-pointer">
                  Verification Mode
                </button>
              </div>
              <div className="pt-20 grid grid-cols-2 md:grid-cols-4 gap-12 text-center opacity-50">
                 {['Fast Execution', 'Privacy Secure', 'Multi-Asset', 'Audit Ready'].map(label => (
                   <div key={label} className="text-[11px] font-black uppercase tracking-[0.3em]">{label}</div>
                 ))}
              </div>
            </motion.div>
          )}

          {(activeTab === 'standard' || activeTab === 'verification') && (
            <motion.div key="process" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-10">
              {/* Main Controls Card */}
              <div className="bg-white p-8 lg:p-12 rounded-[2.5rem] shadow-2xl shadow-slate-200/50 border border-slate-50">
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-12">
                  <div className="lg:col-span-2 space-y-8">
                    <div className="space-y-4">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">Fields to Map</label>
                      <textarea 
                        value={keywords} 
                        onChange={(e) => setKeywords(e.target.value)} 
                        rows={2} 
                        className="w-full rounded-2xl border-2 border-slate-50 p-6 outline-none focus:border-indigo-100 font-mono text-sm bg-slate-50/50 transition-all shadow-inner" 
                        placeholder="UTR, Amount, Date..."
                      />
                    </div>

                    {activeTab === 'verification' && (
                      <div className="flex items-center gap-8 p-6 bg-indigo-50/30 rounded-[2rem] border border-dashed border-indigo-100 relative group">
                        <div className="bg-indigo-600 p-4 rounded-2xl text-white shadow-xl shadow-indigo-200"><FileSpreadsheet className="w-7 h-7" /></div>
                        <div className="flex-1">
                          <h4 className="font-bold text-indigo-900 text-lg mb-0.5">Reference Log (Excel)</h4>
                          <p className="text-xs text-indigo-700/60 font-bold uppercase tracking-widest">Load master data to compare</p>
                        </div>
                        <button onClick={() => excelInputRef.current?.click()} className={`px-8 py-3.5 rounded-xl text-[10px] font-black cursor-pointer transition-all shadow-lg active:scale-95 ${excelData ? 'bg-emerald-600 text-white' : 'bg-indigo-600 text-white'}`}>
                          {excelData ? 'LOG LOADED' : 'UPLOAD MASTER.XLSX'}
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col justify-between">
                    <div className="space-y-4">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1 text-center block">Source Images</label>
                      <div className="grid grid-cols-2 gap-4">
                        <button onClick={() => fileInputRef.current?.click()} className="flex flex-col items-center justify-center p-8 border-2 border-dashed border-slate-100 rounded-3xl hover:border-indigo-300 hover:bg-slate-50 cursor-pointer text-slate-400 transition-all group bg-white shadow-sm">
                          <FileUp className="w-7 h-7 group-hover:-translate-y-1 transition-transform" />
                          <span className="text-[9px] font-black mt-3 uppercase tracking-tighter">Choose Images</span>
                        </button>
                        <button onClick={() => folderInputRef.current?.click()} className="flex flex-col items-center justify-center p-8 border-2 border-dashed border-slate-100 rounded-3xl hover:border-indigo-300 hover:bg-slate-50 cursor-pointer text-slate-400 transition-all group bg-white shadow-sm">
                          <FolderUp className="w-7 h-7 group-hover:-translate-y-1 transition-transform" />
                          <span className="text-[9px] font-black mt-3 uppercase tracking-tighter">Bulk Folder</span>
                        </button>
                      </div>
                    </div>

                    <div className="pt-8 space-y-4">
                      {isExtracting && (
                         <div className="flex justify-between px-1">
                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Engaging {progress}%</span>
                            <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-widest">ETA: {formatTime(Math.max(0, totalEstimatedTime - elapsedTime))}</span>
                         </div>
                      )}
                      <button 
                        onClick={handleExtractBatch} 
                        disabled={files.length === 0 || isExtracting || (activeTab === 'verification' && !excelData)} 
                        className="w-full bg-slate-900 text-white font-black py-5 rounded-[1.5rem] shadow-2xl hover:bg-indigo-600 disabled:bg-slate-100 disabled:text-slate-300 cursor-pointer transition active:scale-[0.98] relative overflow-hidden text-[13px] uppercase tracking-[0.2em]"
                      >
                        {isExtracting ? (
                          <div className="flex items-center justify-center gap-3">
                            <Loader2 className="w-5 h-5 animate-spin" />
                            <span>Processing Batch</span>
                          </div>
                        ) : (
                          <span>Analyze {files.length} Assets</span>
                        )}
                        <AnimatePresence>
                          {progress > 0 && (
                            <motion.div initial={{ width: 0 }} animate={{ width: `${progress}%` }} className="absolute bottom-0 left-0 h-1.5 bg-indigo-400" />
                          )}
                        </AnimatePresence>
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Grid Result Display */}
              {files.length > 0 && (
                <div className="space-y-10">
                  <header className="flex items-center justify-between px-6">
                    <div className="flex items-center gap-10">
                      <h3 className="text-2xl font-bold tracking-tight">Processing Buffer</h3>
                      <div className="flex gap-4">
                        <div className="px-4 py-2 bg-white border border-slate-100 rounded-xl shadow-sm text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
                           <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> Verified: {stats.success}
                        </div>
                        <div className="px-4 py-2 bg-white border border-slate-100 rounded-xl shadow-sm text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
                           <div className="w-1.5 h-1.5 rounded-full bg-amber-500" /> Flagged: {stats.review}
                        </div>
                      </div>
                    </div>
                    <button onClick={clearAll} className="text-[11px] font-bold text-slate-300 hover:text-rose-500 transition-all uppercase tracking-widest">Clear Queue</button>
                  </header>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                    {files.map(f => (
                      <motion.div 
                        key={f.id} 
                        layout 
                        initial={{ opacity: 0, scale: 0.95 }} 
                        animate={{ opacity: 1, scale: 1 }} 
                        className={`bg-white rounded-[2rem] border-2 shadow-xl transition-all flex flex-col group overflow-hidden ${f.verificationResult?.matched === false ? 'border-amber-100 bg-amber-50/5' : 'border-slate-50 hover:border-slate-100'}`}
                      >
                        <div className="p-6 border-b border-slate-50 flex items-center justify-between gap-5 bg-slate-50/10">
                          <div className="flex items-center gap-5 min-w-0">
                            <div 
                              onClick={() => setSelectedImage(f.previewUrl)}
                              className="w-12 h-12 rounded-2xl shrink-0 border border-white overflow-hidden cursor-zoom-in hover:scale-110 transition-transform shadow-lg"
                            >
                              <img src={f.previewUrl} className="w-full h-full object-cover" alt="receipt" />
                            </div>
                            <div className="min-w-0">
                              <p className="text-[13px] font-bold truncate text-slate-900 tracking-tight">{f.file.name}</p>
                              <div className="mt-1 flex items-center gap-2">
                                <span className={`text-[9px] font-black px-2 py-0.5 rounded-md ${
                                  f.status === 'success' ? 'bg-emerald-50 text-emerald-700' :
                                  f.status === 'needs_review' ? 'bg-amber-50 text-amber-700' :
                                  f.status === 'processing' ? 'bg-indigo-50 text-indigo-700 animate-pulse' :
                                  f.status === 'error' ? 'bg-rose-50 text-rose-700' : 'bg-slate-100 text-slate-500'
                                } uppercase tracking-tighter`}>
                                  {f.status}
                                </span>
                                {f.processingTime && <span className="text-[9px] font-bold text-slate-300">{(f.processingTime/1000).toFixed(1)}s</span>}
                              </div>
                            </div>
                          </div>
                          <button onClick={() => setFiles(prev => prev.filter(i => i.id !== f.id))} className="p-2.5 hover:bg-rose-50 text-slate-200 hover:text-rose-500 rounded-xl transition-all">
                            <X className="w-4 h-4" />
                          </button>
                        </div>

                        <div className="p-8 flex-1 flex flex-col justify-between space-y-6">
                          <div className="space-y-4">
                            {f.data?.map((d, i) => (
                              <div key={i} className="flex justify-between items-center text-[11px]">
                                <span className="text-slate-400 font-bold uppercase tracking-widest">{d.keyword}</span>
                                <span className={`font-mono px-3 py-1.5 rounded-xl border border-slate-50 ${d.value === 'Not found' ? 'text-slate-300 italic' : 'bg-slate-50 text-slate-900 font-bold shadow-sm'}`}>
                                  {d.value}
                                </span>
                              </div>
                            ))}
                          </div>
                          
                          {f.verificationResult && (
                            <div className={`p-5 rounded-[1.5rem] border-2 shadow-sm transition-all ${f.verificationResult.matched ? 'bg-emerald-50/40 border-emerald-100' : 'bg-amber-50/40 border-amber-100'}`}>
                              <div className="flex justify-between items-center mb-2.5">
                                <span className="text-[8px] font-black uppercase tracking-[0.3em] text-slate-400">Match Accuracy</span>
                                <span className={`text-[10px] font-black ${f.verificationResult.matched ? 'text-emerald-700' : 'text-amber-700'}`}>{f.verificationResult.percentage}% Reliable</span>
                              </div>
                              <p className="text-[12px] font-medium text-slate-700 leading-snug italic">"{f.verificationResult.remarks}"</p>
                            </div>
                          )}
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {activeTab === 'history' && (
            <motion.div key="history" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="bg-white rounded-[3rem] border border-slate-50 shadow-2xl overflow-hidden">
              <div className="p-12 border-b border-slate-50 flex items-center justify-between bg-slate-50/10">
                <div className="space-y-1">
                  <h2 className="text-3xl font-bold tracking-tight">Historic Logs</h2>
                  <p className="text-sm text-slate-400 font-bold uppercase tracking-widest opacity-60">Audit trail of past processing events.</p>
                </div>
                <button onClick={() => { setHistory([]); localStorage.removeItem('ocr_history'); }} className="text-[10px] font-black text-rose-500 hover:bg-rose-50 border border-rose-100 px-6 py-2.5 rounded-xl cursor-pointer uppercase transition-all">Flush Logs</button>
              </div>
              {history.length > 0 ? (
                <div className="p-12">
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-left">
                      <thead className="text-[10px] font-black uppercase text-slate-400 tracking-widest">
                        <tr>
                          <th className="px-8 py-6">Timestamp</th>
                          <th className="px-8 py-6">Category</th>
                          <th className="px-8 py-6">Volume</th>
                          <th className="px-8 py-6 text-right">Integrity</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {history.map(h => (
                          <tr key={h.id} className="group hover:bg-slate-50 transition-colors">
                            <td className="px-8 py-6 text-sm font-bold text-slate-900">{h.date}</td>
                            <td className="px-8 py-6"><span className="px-3 py-1 bg-indigo-50 text-indigo-700 text-[10px] font-black rounded-lg uppercase border border-indigo-100">{h.type}</span></td>
                            <td className="px-8 py-6 text-sm text-slate-500 font-medium">{h.fileCount} Objects</td>
                            <td className="px-8 py-6 text-right"><span className="inline-flex items-center gap-2 text-emerald-500 font-black text-[10px] uppercase tracking-widest"><Check className="w-4 h-4" /> Finalized</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="py-40 text-center space-y-8">
                  <div className="w-24 h-24 bg-slate-50 rounded-[2rem] flex items-center justify-center mx-auto text-slate-200 border border-slate-50"><HistoryIcon className="w-10 h-10" /></div>
                  <div className="space-y-2">
                    <p className="text-slate-900 font-bold text-xl tracking-tight">Archive Empty</p>
                    <p className="text-slate-400 font-bold max-w-[200px] mx-auto text-xs uppercase tracking-widest leading-relaxed">Recent batch events will be cataloged here for audit.</p>
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Floating Status Bar */}
      <footer className="fixed bottom-8 left-1/2 -translate-x-1/2 bg-slate-900/90 backdrop-blur-xl text-white px-8 py-4 rounded-full flex items-center gap-10 shadow-2xl border border-white/10 z-50">
         <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]" />
            <span className="text-[10px] font-black uppercase tracking-widest">Engine Active</span>
         </div>
         <div className="h-4 w-[1px] bg-white/10" />
         <div className="flex items-center gap-3 text-white/50 text-[10px] font-black uppercase tracking-widest">
            <ShieldCheck className="w-3 h-3" /> Zero-Storage Policy
         </div>
         <div className="h-4 w-[1px] bg-white/10" />
         <p className="text-[10px] font-black uppercase tracking-widest text-indigo-400">© 2026 SmartVerify</p>
      </footer>

      <AnimatePresence>
        {selectedImage && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[100] bg-slate-950/98 flex items-center justify-center p-12 backdrop-blur-3xl" onClick={() => setSelectedImage(null)}>
             <div className="relative max-w-full max-h-full flex flex-col items-center">
              <motion.img initial={{ scale: 0.98 }} animate={{ scale: 1 }} src={selectedImage} alt="expansion" className="rounded-[2.5rem] shadow-[0_0_100px_rgba(79,70,229,0.2)] max-h-[85vh] object-contain border-[10px] border-white/5" />
              <button className="absolute -top-10 -right-10 bg-white text-slate-900 p-4 rounded-2xl cursor-pointer shadow-2xl hover:scale-110 active:scale-95 transition-all"><X className="w-7 h-7" /></button>
              <p className="text-white/40 text-[10px] font-black uppercase tracking-[0.5em] mt-10">Esc to Close View</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
