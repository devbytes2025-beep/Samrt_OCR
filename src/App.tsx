import { useState, useRef, ChangeEvent } from 'react';
import { Upload, Image as ImageIcon, FileText, Download, Loader2, CheckCircle2, AlertCircle, X, FolderUp, FileUp, RefreshCw, FileSpreadsheet, AlertTriangle, ZoomIn, BarChart3 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI, Type } from '@google/genai';
import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

interface ExtractedData {
  keyword: string;
  value: string;
  confidence: number;
}

interface ProcessedFile {
  id: string;
  file: File;
  previewUrl: string;
  status: 'idle' | 'processing' | 'success' | 'needs_review' | 'error';
  data: ExtractedData[] | null;
  errorMessage?: string;
}

export default function App() {
  const [files, setFiles] = useState<ProcessedFile[]>([]);
  const [keywords, setKeywords] = useState<string>('UTR, Amount, Date, Reference Number');
  const [isExtracting, setIsExtracting] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number>(0);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const [replaceTargetId, setReplaceTargetId] = useState<string | null>(null);

  const handleFilesAdded = (newFiles: FileList | File[]) => {
    const validFiles = Array.from(newFiles).filter(f => f.type.startsWith('image/'));
    
    if (validFiles.length === 0) {
      setGlobalError('No valid image files found.');
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
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      handleFilesAdded(e.target.files);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleFolderChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      handleFilesAdded(e.target.files);
    }
    if (folderInputRef.current) folderInputRef.current.value = '';
  };

  const handleReplaceFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile && replaceTargetId) {
      if (!selectedFile.type.startsWith('image/')) {
        setGlobalError('Please upload a valid image file.');
        return;
      }
      
      setFiles(prev => prev.map(f => {
        if (f.id === replaceTargetId) {
          URL.revokeObjectURL(f.previewUrl);
          return {
            ...f,
            file: selectedFile,
            previewUrl: URL.createObjectURL(selectedFile),
            status: 'idle',
            data: null,
            errorMessage: undefined
          };
        }
        return f;
      }));
    }
    setReplaceTargetId(null);
    if (replaceInputRef.current) replaceInputRef.current.value = '';
  };

  const triggerReplace = (id: string) => {
    setReplaceTargetId(id);
    if (replaceInputRef.current) {
      replaceInputRef.current.click();
    }
  };

  const removeFile = (id: string) => {
    setFiles(prev => {
      const fileToRemove = prev.find(f => f.id === id);
      if (fileToRemove) {
        URL.revokeObjectURL(fileToRemove.previewUrl);
      }
      return prev.filter(f => f.id !== id);
    });
  };

  const clearAll = () => {
    files.forEach(f => URL.revokeObjectURL(f.previewUrl));
    setFiles([]);
    setGlobalError(null);
    setProgress(0);
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result.split(',')[1]);
        } else {
          reject(new Error('Failed to convert file'));
        }
      };
      reader.onerror = error => reject(error);
    });
  };

  const processFile = async (fileObj: ProcessedFile) => {
    setFiles(prev => prev.map(f => f.id === fileObj.id ? { ...f, status: 'processing', errorMessage: undefined } : f));

    try {
      const base64Image = await fileToBase64(fileObj.file);
      
      const prompt = `
        You are an expert OCR and data extraction system specialized in payment slips (like PhonePe, Paytm, Google Pay).
        I am providing an image of a payment slip or receipt.
        I need you to extract specific information based on the following keywords/fields: ${keywords}.
        
        For each keyword, find the corresponding value in the image. Be smart about synonyms (e.g., if keyword is "UTR", look for "UTR", "Ref No", "Reference Number", "Txn ID").
        Also, provide a confidence score between 0 and 100 indicating how certain you are about the extracted value based on the image clarity and text legibility.
        
        If a keyword's value is not found in the image, return "Not found" for the value and 0 for confidence.
      `;

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          {
            inlineData: {
              data: base64Image,
              mimeType: fileObj.file.type
            }
          },
          prompt
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                keyword: { type: Type.STRING },
                value: { type: Type.STRING },
                confidence: { type: Type.NUMBER, description: "Confidence score from 0 to 100" }
              },
              required: ["keyword", "value", "confidence"]
            }
          }
        }
      });

      const jsonText = response.text;
      if (jsonText) {
        const parsedData = JSON.parse(jsonText) as ExtractedData[];
        const needsReview = parsedData.some(d => d.value === 'Not found' || d.confidence < 50);
        
        setFiles(prev => prev.map(f => f.id === fileObj.id ? { 
          ...f, 
          status: needsReview ? 'needs_review' : 'success', 
          data: parsedData 
        } : f));
      } else {
        throw new Error('No data returned from AI');
      }
    } catch (err) {
      console.error(err);
      setFiles(prev => prev.map(f => f.id === fileObj.id ? { 
        ...f, 
        status: 'error', 
        errorMessage: 'Failed to extract data. Image might be unclear.' 
      } : f));
    }
  };

  const handleExtractAll = async () => {
    const filesToProcess = files.filter(f => f.status === 'idle' || f.status === 'error' || f.status === 'needs_review');
    
    if (filesToProcess.length === 0) {
      setGlobalError('No pending images to process.');
      return;
    }
    if (!keywords.trim()) {
      setGlobalError('Please enter at least one keyword.');
      return;
    }

    setIsExtracting(true);
    setGlobalError(null);
    setProgress(0);

    let completed = 0;
    for (const fileObj of filesToProcess) {
      await processFile(fileObj);
      completed++;
      setProgress(Math.round((completed / filesToProcess.length) * 100));
    }

    setIsExtracting(false);
    setTimeout(() => setProgress(0), 2000); // Hide progress bar after 2 seconds
  };

  const downloadExcel = () => {
    const rows = files.map(f => {
      const row: any = {
        'File Name': f.file.name,
        'Status': f.status === 'success' ? 'Success' : f.status === 'needs_review' ? 'Needs Review' : f.status === 'error' ? 'Error' : 'Not Processed',
      };
      
      if (f.data) {
        f.data.forEach(d => {
          row[d.keyword] = d.value;
          row[`${d.keyword} Confidence`] = d.confidence + '%';
        });
      }
      return row;
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Extracted Data");
    XLSX.writeFile(wb, "extracted_receipts.xlsx");
  };

  const downloadPDF = () => {
    const doc = new jsPDF('landscape');
    doc.text("SmartReceipt OCR - Extracted Data", 14, 15);
    
    // Get all unique keywords to form columns
    const allKeywords = new Set<string>();
    files.forEach(f => f.data?.forEach(d => allKeywords.add(d.keyword)));
    const keywordsList = Array.from(allKeywords);
    
    const head = [['File Name', 'Status', ...keywordsList]];
    const body = files.map(f => {
      const row = [
        f.file.name, 
        f.status === 'success' ? 'Success' : f.status === 'needs_review' ? 'Needs Review' : f.status === 'error' ? 'Error' : 'Not Processed'
      ];
      keywordsList.forEach(kw => {
        const found = f.data?.find(d => d.keyword === kw);
        row.push(found ? `${found.value} (${found.confidence}%)` : '-');
      });
      return row;
    });

    autoTable(doc, {
      head: head,
      body: body,
      startY: 20,
      styles: { fontSize: 9, cellPadding: 3 },
      headStyles: { fillColor: [79, 70, 229], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      margin: { top: 20 }
    });
    
    doc.save("extracted_receipts.pdf");
  };

  const getConfidenceColor = (score: number) => {
    if (score >= 90) return 'text-emerald-600 bg-emerald-50 border-emerald-200';
    if (score >= 70) return 'text-amber-600 bg-amber-50 border-amber-200';
    return 'text-rose-600 bg-rose-50 border-rose-200';
  };

  const getStatusBadge = (status: ProcessedFile['status']) => {
    switch (status) {
      case 'idle': return <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-700 border border-slate-200"><FileText className="w-3 h-3" /> Ready</span>;
      case 'processing': return <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-200"><Loader2 className="w-3 h-3 animate-spin" /> Processing</span>;
      case 'success': return <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200"><CheckCircle2 className="w-3 h-3" /> Success</span>;
      case 'needs_review': return <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200"><AlertTriangle className="w-3 h-3" /> Needs Review</span>;
      case 'error': return <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-rose-50 text-rose-700 border border-rose-200"><AlertCircle className="w-3 h-3" /> Error</span>;
    }
  };

  const hasProcessedFiles = files.some(f => f.status === 'success' || f.status === 'needs_review');
  const stats = {
    total: files.length,
    success: files.filter(f => f.status === 'success').length,
    needsReview: files.filter(f => f.status === 'needs_review').length,
    error: files.filter(f => f.status === 'error').length,
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-indigo-100 selection:text-indigo-900 pb-20">
      {/* Hidden Inputs */}
      <input type="file" multiple accept="image/*" ref={fileInputRef} onChange={handleFileChange} className="hidden" />
      <input type="file" {...{ webkitdirectory: "", directory: "" } as any} ref={folderInputRef} onChange={handleFolderChange} className="hidden" />
      <input type="file" accept="image/*" ref={replaceInputRef} onChange={handleReplaceFileChange} className="hidden" />

      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-20 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-indigo-600 p-2 rounded-lg">
              <FileSpreadsheet className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">SmartReceipt Batch OCR</h1>
          </div>
          {hasProcessedFiles && (
            <div className="flex items-center gap-3">
              <button
                onClick={downloadExcel}
                className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors shadow-sm cursor-pointer"
              >
                <Download className="w-4 h-4" />
                Excel
              </button>
              <button
                onClick={downloadPDF}
                className="flex items-center gap-2 bg-rose-600 hover:bg-rose-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors shadow-sm cursor-pointer"
              >
                <Download className="w-4 h-4" />
                PDF
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        
        {/* Settings & Upload Panel */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            
            <div className="lg:col-span-2 space-y-4">
              <div>
                <label htmlFor="keywords" className="block text-sm font-medium text-slate-700 mb-1">
                  Keywords to Extract (comma separated)
                </label>
                <textarea
                  id="keywords"
                  value={keywords}
                  onChange={(e) => setKeywords(e.target.value)}
                  rows={2}
                  className="w-full rounded-xl border-slate-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm p-3 border resize-none cursor-text"
                  placeholder="e.g., UTR, Amount, Date, Sender Name"
                />
                <p className="text-xs text-slate-500 mt-2">
                  Specify the exact fields you want to extract from the payment slips.
                </p>
              </div>
              
              <AnimatePresence>
                {globalError && (
                  <motion.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="p-3 bg-rose-50 border border-rose-200 rounded-lg flex items-start gap-2"
                  >
                    <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                    <p className="text-sm text-rose-700">{globalError}</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="space-y-3 flex flex-col justify-end">
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex flex-col items-center justify-center gap-2 p-4 border-2 border-dashed border-slate-300 rounded-xl hover:border-indigo-400 hover:bg-indigo-50 transition-colors text-slate-600 hover:text-indigo-600 cursor-pointer"
                >
                  <FileUp className="w-6 h-6" />
                  <span className="text-sm font-medium">Add Files</span>
                </button>
                <button
                  onClick={() => folderInputRef.current?.click()}
                  className="flex flex-col items-center justify-center gap-2 p-4 border-2 border-dashed border-slate-300 rounded-xl hover:border-indigo-400 hover:bg-indigo-50 transition-colors text-slate-600 hover:text-indigo-600 cursor-pointer"
                >
                  <FolderUp className="w-6 h-6" />
                  <span className="text-sm font-medium">Add Folder</span>
                </button>
              </div>
              
              <div className="relative">
                <button
                  onClick={handleExtractAll}
                  disabled={files.length === 0 || isExtracting || !keywords.trim()}
                  className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-medium py-3 px-4 rounded-xl transition-colors shadow-sm cursor-pointer"
                >
                  {isExtracting ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Processing Batch... {progress}%
                    </>
                  ) : (
                    <>
                      <RefreshCw className="w-5 h-5" />
                      Extract All ({files.length})
                    </>
                  )}
                </button>
                
                {/* Progress Bar */}
                <AnimatePresence>
                  {progress > 0 && (
                    <motion.div 
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 4 }}
                      exit={{ opacity: 0, height: 0 }}
                      className="absolute -bottom-2 left-0 right-0 bg-slate-100 rounded-full overflow-hidden"
                    >
                      <motion.div 
                        className="h-full bg-indigo-500"
                        initial={{ width: 0 }}
                        animate={{ width: `${progress}%` }}
                        transition={{ duration: 0.3 }}
                      />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>

          </div>
        </div>

        {/* Summary Stats (Suggestion) */}
        {files.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center gap-4">
              <div className="p-3 bg-slate-50 rounded-lg text-slate-600"><BarChart3 className="w-5 h-5" /></div>
              <div>
                <p className="text-sm text-slate-500 font-medium">Total Files</p>
                <p className="text-xl font-semibold text-slate-900">{stats.total}</p>
              </div>
            </div>
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center gap-4">
              <div className="p-3 bg-emerald-50 rounded-lg text-emerald-600"><CheckCircle2 className="w-5 h-5" /></div>
              <div>
                <p className="text-sm text-slate-500 font-medium">Success</p>
                <p className="text-xl font-semibold text-emerald-700">{stats.success}</p>
              </div>
            </div>
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center gap-4">
              <div className="p-3 bg-amber-50 rounded-lg text-amber-600"><AlertTriangle className="w-5 h-5" /></div>
              <div>
                <p className="text-sm text-slate-500 font-medium">Needs Review</p>
                <p className="text-xl font-semibold text-amber-700">{stats.needsReview}</p>
              </div>
            </div>
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center gap-4">
              <div className="p-3 bg-rose-50 rounded-lg text-rose-600"><AlertCircle className="w-5 h-5" /></div>
              <div>
                <p className="text-sm text-slate-500 font-medium">Errors</p>
                <p className="text-xl font-semibold text-rose-700">{stats.error}</p>
              </div>
            </div>
          </div>
        )}

        {/* Results Grid */}
        {files.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-medium text-slate-900">Uploaded Receipts</h2>
              <button onClick={clearAll} className="text-sm text-slate-500 hover:text-rose-600 font-medium transition-colors cursor-pointer">
                Clear All
              </button>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
              <AnimatePresence>
                {files.map((fileObj) => (
                  <motion.div
                    key={fileObj.id}
                    layout
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className={`bg-white rounded-2xl shadow-sm border overflow-hidden flex flex-col ${
                      fileObj.status === 'needs_review' ? 'border-amber-300 ring-1 ring-amber-300' : 
                      fileObj.status === 'error' ? 'border-rose-300 ring-1 ring-rose-300' : 'border-slate-200'
                    }`}
                  >
                    {/* Card Header */}
                    <div className="p-4 border-b border-slate-100 flex items-start justify-between gap-4 bg-slate-50/50">
                      <div className="flex items-center gap-3 min-w-0">
                        <div 
                          className="w-12 h-12 rounded-lg border border-slate-200 overflow-hidden shrink-0 bg-white relative group cursor-pointer"
                          onClick={() => setSelectedImage(fileObj.previewUrl)}
                        >
                          <img src={fileObj.previewUrl} alt="Preview" className="w-full h-full object-cover" />
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <ZoomIn className="w-5 h-5 text-white" />
                          </div>
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-slate-900 truncate" title={fileObj.file.name}>
                            {fileObj.file.name}
                          </p>
                          <div className="mt-1">
                            {getStatusBadge(fileObj.status)}
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={() => removeFile(fileObj.id)}
                        className="text-slate-400 hover:text-rose-500 p-1 rounded-md hover:bg-rose-50 transition-colors shrink-0 cursor-pointer"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    {/* Card Body */}
                    <div className="p-4 flex-1 flex flex-col">
                      {fileObj.status === 'processing' ? (
                        <div className="flex-1 flex flex-col items-center justify-center text-slate-400 py-6">
                          <Loader2 className="w-6 h-6 animate-spin text-indigo-600 mb-2" />
                          <p className="text-xs">Analyzing image...</p>
                        </div>
                      ) : fileObj.data ? (
                        <div className="space-y-3 flex-1">
                          {fileObj.data.map((item, idx) => (
                            <div key={idx} className="flex items-center justify-between text-sm">
                              <span className="text-slate-500 truncate pr-2" title={item.keyword}>{item.keyword}:</span>
                              <div className="flex items-center gap-2 shrink-0">
                                <span className={`font-mono truncate max-w-[120px] ${item.value === 'Not found' ? 'text-rose-500 italic' : 'text-slate-900'}`} title={item.value}>
                                  {item.value}
                                </span>
                                <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${getConfidenceColor(item.confidence)}`}>
                                  {item.confidence}%
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : fileObj.errorMessage ? (
                        <div className="flex-1 flex items-center justify-center text-center py-6">
                          <p className="text-sm text-rose-600">{fileObj.errorMessage}</p>
                        </div>
                      ) : (
                        <div className="flex-1 flex items-center justify-center text-center py-6">
                          <p className="text-sm text-slate-400">Waiting to process...</p>
                        </div>
                      )}

                      {/* Action Footer for Needs Review / Error */}
                      {(fileObj.status === 'needs_review' || fileObj.status === 'error') && (
                        <div className="mt-4 pt-4 border-t border-slate-100">
                          <button
                            onClick={() => triggerReplace(fileObj.id)}
                            className="w-full flex items-center justify-center gap-2 text-sm font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 py-2 rounded-lg transition-colors border border-amber-200 cursor-pointer"
                          >
                            <RefreshCw className="w-4 h-4" />
                            Replace Image
                          </button>
                        </div>
                      )}
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </div>
        )}

      </main>

      {/* Image Preview Modal */}
      <AnimatePresence>
        {selectedImage && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/80 backdrop-blur-sm p-4"
            onClick={() => setSelectedImage(null)}
          >
            <motion.div 
              initial={{ scale: 0.95 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.95 }}
              className="relative max-w-5xl max-h-[90vh] w-full flex items-center justify-center"
              onClick={(e) => e.stopPropagation()}
            >
              <img 
                src={selectedImage} 
                alt="Full Preview" 
                className="max-w-full max-h-[90vh] object-contain rounded-xl shadow-2xl"
              />
              <button 
                onClick={() => setSelectedImage(null)}
                className="absolute -top-4 -right-4 bg-white text-slate-900 p-2 rounded-full shadow-lg hover:bg-rose-50 hover:text-rose-600 transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
