const express=require('express');
const {Server}=require('socket.io');
const cors=require('cors');
const http=require('http');
const app=express();
const fs=require('fs')
const axios=require('axios')
const dotenv=require('dotenv')
const {Readable}=require('stream')
const {S3Client,PutObjectCommand}=require('@aws-sdk/client-s3');
const { Credentials } = require('aws-sdk');
const OpenAI=require('openai');
dotenv.config();

const server=http.createServer(app);

app.use(cors());

const openai=new OpenAI({
    apiKey:process.env.OPEN_AI_KEY
})

const io=new Server(server,{
    cors:{
        origin:process.env.ELECTRON_HOST,
        methods:['GET','POST']
    }
});



const s3 = new S3Client({
    region: process.env.BUCKET_REGION, // Specify your AWS region
    credentials: {
      accessKeyId: process.env.ACCESS_KEY, // Replace with your AWS access key ID
      secretAccessKey: process.env.SECRET_KEY, // Replace with your AWS secret access key
    },

  });

let recordedChunks=[];
io.on('connection',(socket)=>{
    console.log('socker connected')
    socket.on("video-chunks",async(data)=>{
        console.log("video chunk is sent");
        const writestream=fs.createWriteStream('temp_upload/'+data.filename)
        recordedChunks.push(data.chunks)
        const videoBlob=new Blob(recordedChunks,{type:'video/webm; codecs=vp9'})
        const buffer=Buffer.from(await videoBlob.arrayBuffer())
        const readStream=Readable.from(buffer)
        readStream.pipe(writestream).on('finish',()=>{
            console.log("Chunk is saved")
        })
        
    })


    socket.on("process-video",async(data)=>{
        console.log("Processing Video...")
        recordedChunks=[]
        fs.readFile('temp_upload/'+data.filename,async(err,file)=>{
            console.log("printing the dataId:"+data.userId)
            const processing=await axios.post(`${process.env.NEXT_API_HOST}recording/${data.userId}/processing`,
                {filename:data.filename}
            );
            if(processing.data.status!==200){
                return console.log('Error:Something went wrong with creating the processing file');
            }
            const Key=data.filename
            const Bucket=process.env.BUCKET_NAME
            const ContentType='video/webm'
            const command=new PutObjectCommand({Bucket,Key,ContentType,Body:file})
            const fileStatus=await s3.send(command);
            // transcribe
            if(fileStatus['$metadata'].httpStatusCode===200){
                console.log("video uploaded to AWS S3")
              if(processing.data.plan==='PRO'){
                fs.stat('temp_upload/'+data.filename,async(err,stat)=>{
                if(!err){
                    if(stat.size<25000000){
                    const transcription=await openai.audio.transcriptions.create({
                        file:fs.createReadStream(`temp_upload/${data.filename}`),
                        model:'whisper-1',
                        response_format:'text'
                    })
                    if(transcription){
                        const completion=await openai.chat.completions.create({
                            model:'gpt-3.5-turbo',
                            response_format:{type:'json_object'},
                            messages:[
                                {
                                    role:'system',
                                    content: `You are going to generate a title and a nice description using the speech to text transcription provided: transcription(${transcription}) and then return it in json format as {"title": <the title you gave>, "summary": <the summary you created>}`,
                                }
                            ]
                        })
                        console.log(completion.choices[0].message.content)
                        const titleAndSummaryGenerated=await axios.post(`${process.env.NEXT_API_HOST}recording/${data.userId}/transcribe`,{
                            filename:data.filename,
                            content:completion.choices[0].message.content,
                            transcript:transcription
                        })
                        console.log("hello")
                        console.log(titleAndSummaryGenerated)
                        if(titleAndSummaryGenerated.data.status!==200){
                            console.log("Something went wrong when creating the title and description");

                        }
                    }
                    }
                }
              })
            }

        const stopProcessing=await axios.post(`${process.env.NEXT_API_HOST}recording/${data.userId}/complete`,{
            filename:data.filename
        })
        if(stopProcessing.data.status!==200){
            console.log("something went wrong when stopping the process and trying to complete the processing process")
        }
        if(stopProcessing.status===200){
            fs.unlink('temp_upload/'+data.filename,(err)=>{
                if(!err){
                    console.log(data.filename+' '+'deleted successfully')
                }
            })
        
        }else{
            console.log("Something went wrong when trying to delete the file")
        }

    }})
    })
    socket.on('disconnect',async(data)=>{
        console.log("Socket.id is disconnected",socket.id)
    })
})



server.listen(process.env.PORT_URL,()=>{
    console.log('Listening to port 5001')
})