import { Injectable, OnModuleInit } from '@nestjs/common';

@Injectable()
export class InitService implements OnModuleInit{

    constructor(){}

    async onModuleInit(){
        try {
            
            // ### Обновляем логи
            this.InitialLogging()

        } catch (error) {
            console.log("InitService, onModuleInit", error);
        }
    }

    InitialLogging(){
        const originalLog = console.log;
        console.log = function (...args) {
            const now = new Date();
            const timestamp = now.toLocaleString("ru-RU", {
                day: "2-digit",
                month: "2-digit",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
            });
            originalLog(`${timestamp}|`, ...args);
        }
    }

}