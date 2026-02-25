"use client"

import { Calendar, Download } from 'lucide-react'
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from "recharts"

const data = [
  { date: "Jan 1", price: 355 }, { date: "Jan 8", price: 358 }, { date: "Jan 15", price: 345 },
  { date: "Jan 22", price: 365 }, { date: "Jan 29", price: 355 }, { date: "Feb 5", price: 360 },
  { date: "Feb 12", price: 345 }, { date: "Feb 19", price: 348 }, { date: "Feb 26", price: 320 },
  { date: "Mar 5", price: 285 }, { date: "Mar 12", price: 305 }, { date: "Mar 19", price: 325 },
  { date: "Mar 26", price: 328 }, { date: "Apr 2", price: 318 }, { date: "Apr 9", price: 325 },
  { date: "Apr 16", price: 315 }, { date: "Apr 23", price: 320 }, { date: "Apr 30", price: 345 },
  { date: "May 7", price: 335 }, { date: "May 14", price: 330 }, { date: "May 21", price: 320 },
  { date: "May 28", price: 300 }, { date: "Jun 4", price: 315 }, { date: "Jun 11", price: 310 },
  { date: "Jun 18", price: 318 }, { date: "Jun 25", price: 312 }, { date: "Jul 2", price: 325 },
  { date: "Jul 9", price: 330 }, { date: "Jul 16", price: 332 }, { date: "Jul 23", price: 305 },
  { date: "Jul 30", price: 325 }, { date: "Aug 6", price: 315 }, { date: "Aug 13", price: 305 },
  { date: "Aug 20", price: 312 }, { date: "Aug 27", price: 335 }, { date: "Sep 3", price: 340 },
  { date: "Sep 10", price: 338 }, { date: "Sep 17", price: 330 }, { date: "Sep 24", price: 335 },
  { date: "Oct 1", price: 320 }, { date: "Oct 8", price: 340 }, { date: "Oct 15", price: 350 },
  { date: "Oct 22", price: 345 }, { date: "Oct 29", price: 330 }, { date: "Nov 5", price: 335 },
  { date: "Nov 12", price: 348 }, { date: "Nov 19", price: 348 }, { date: "Nov 26", price: 380 },
  { date: "Dec 3", price: 410 }, { date: "Dec 10", price: 420 }, { date: "Dec 17", price: 428 },
  { date: "Dec 24", price: 415 }, { date: "Dec 31", price: 425 }, { date: "Jan 7", price: 445 },
  { date: "Jan 14", price: 420 }, { date: "Jan 21", price: 435 }, { date: "Jan 28", price: 450 },
  { date: "Feb 4", price: 430 }, { date: "Feb 11", price: 455 }, { date: "Feb 18", price: 435 },
  { date: "Feb 25", price: 440 }, { date: "Mar 4", price: 430 }, { date: "Mar 11", price: 410 },
  { date: "Mar 18", price: 425 }, { date: "Mar 25", price: 435 }, { date: "Apr 1", price: 428 },
  { date: "Apr 8", price: 440 }, { date: "Apr 15", price: 450 }, { date: "Apr 22", price: 430 },
  { date: "Apr 29", price: 460 }, { date: "May 6", price: 460 }, { date: "May 13", price: 440 },
  { date: "May 20", price: 465 }, { date: "May 27", price: 450 }, { date: "Jun 3", price: 460 },
  { date: "Jun 10", price: 435 }, { date: "Jun 17", price: 445 }, { date: "Jun 24", price: 430 },
  { date: "Jul 1", price: 400 }, { date: "Jul 8", price: 405 }, { date: "Jul 15", price: 400 }
]

export function PerformanceChart() {
  return (
    <div className="flex flex-col gap-6 p-6 bg-[#0D0D0D] rounded-2xl">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 md:gap-2 lg:gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-medium text-white">Performance</h2>
          <div className="flex items-center gap-2 px-3 py-1 bg-[#1A1A1A] rounded-full border border-[#333]">
            <div className="w-4 h-4 rounded-full bg-red-600 flex items-center justify-center">
              <span className="text-[10px] font-bold text-white">T</span>
            </div>
            <span className="text-sm font-medium text-white">TSLA</span>
          </div>
        </div>
        
        <div className="flex items-center gap-4 md:gap-2 lg:gap-4">
          <div className="flex items-center bg-[#1A1A1A] rounded-lg p-1">
            {['1D', '1M', '3M', '6M', '1Y'].map((period) => (
              <button
                key={period}
                className={`px-3 md:px-2 lg:px-3 py-1 text-sm md:text-xs lg:text-sm rounded-md transition-colors ${
                  period === '6M' 
                    ? 'bg-[#2A2A2A] text-white shadow-sm' 
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                {period}
              </button>
            ))}
          </div>
          
          <div className="flex items-center gap-2">
            <button className="p-2 text-gray-400 hover:text-white bg-[#1A1A1A] rounded-lg transition-colors">
              <Calendar className="h-5 w-5" />
            </button>
            <button className="p-2 text-gray-400 hover:text-white bg-[#1A1A1A] rounded-lg transition-colors">
              <Download className="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>

      <div className="h-[400px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <defs>
              <linearGradient id="colorPrice" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#86efac" stopOpacity={0.3}/>
                <stop offset="95%" stopColor="#86efac" stopOpacity={0}/>
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1F1F1F" vertical={false} />
            <XAxis 
              dataKey="date" 
              hide 
            />
            <YAxis 
              domain={[250, 500]} 
              orientation="left" 
              tick={{ fill: '#666' }} 
              axisLine={false}
              tickLine={false}
              ticks={[250, 300, 350, 400, 450, 500]}
            />
            <Tooltip 
              content={({ active, payload }) => {
                if (active && payload && payload.length) {
                  const first = payload[0]
                  if (!first) {
                    return null
                  }
                  const numericValue =
                    typeof first.value === "number"
                      ? first.value
                      : Number(first.value ?? 0)
                  const label = typeof first.payload?.date === "string" ? first.payload.date : ""

                  return (
                    <div className="bg-[#1A1A1A] border border-[#333] p-2 rounded-lg shadow-xl">
                      <p className="text-white font-medium">
                        {numericValue.toFixed(2)} USD <span className="text-gray-400 text-sm ml-2">{label}</span>
                      </p>
                    </div>
                  )
                }
                return null
              }}
            />
            
            <Area 
              type="monotone" 
              dataKey="price" 
              stroke="#86efac" 
              strokeWidth={2} 
              fillOpacity={1} 
              fill="url(#colorPrice)" 
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
